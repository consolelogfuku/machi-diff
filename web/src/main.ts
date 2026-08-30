import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import "./style.css";

// 差分の5分類。順序はそのまま凡例の並びになる
const CATEGORIES = [
  { id: "appeared", label: "新築", color: "#2563eb" },
  { id: "changed", label: "変わった", color: "#f59e0b" },
  { id: "gone", label: "解体", color: "#dc2626" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

// 用途15種。変化の色（青・橙・赤）と混同しないよう、
// 紫・青緑・砂・灰の系統でまとめている
const USAGES = [
  { id: "411", label: "住宅", color: "#d2b184" },
  { id: "412", label: "共同住宅", color: "#bb9560" },
  { id: "413", label: "店舗等併用住宅", color: "#a67f52" },
  { id: "414", label: "店舗等併用共同住宅", color: "#8e6b45" },
  { id: "415", label: "作業所併用住宅", color: "#75573a" },
  { id: "401", label: "業務施設", color: "#7d6ea8" },
  { id: "402", label: "商業施設", color: "#a25f95" },
  { id: "403", label: "宿泊施設", color: "#b87fae" },
  { id: "404", label: "商業系複合施設", color: "#8a5686" },
  { id: "421", label: "官公庁施設", color: "#4a8f88" },
  { id: "422", label: "文教厚生施設", color: "#5fa99a" },
  { id: "431", label: "運輸倉庫施設", color: "#6d8296" },
  { id: "441", label: "工場", color: "#7d8b6c" },
  { id: "451", label: "農林漁業用施設", color: "#93a46d" },
  { id: "452", label: "供給処理施設", color: "#6f7a85" },
  { id: "453", label: "防衛施設", color: "#575e69" },
  { id: "454", label: "その他", color: "#aaa49a" },
  { id: "461", label: "不明", color: "#c6c1b8" },
] as const;

// 変化なしの建物の色。街並みとして残すので彩度を持たせない
const NEUTRAL = "#c8c3ba";

// 地面の彩色の凡例。土地利用の区分をそのまま出す
const GROUND_LEGEND = [
  { label: "公園・緑地", color: "#8fc47a" },
  { label: "山林", color: "#6fa361" },
  { label: "畑・樹園地", color: "#c9d79a" },
  { label: "水面", color: "#8fc7e8" },
  { label: "空地", color: "#e2e0d2" },
] as const;

// pmtiles:// スキームを MapLibre に登録する。
// これで .pmtiles 1ファイルへの Range リクエストだけでタイルが引ける
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// 表示中の分類は URL に載せる。地図の位置は MapLibre の hash が面倒を見る
const params = new URLSearchParams(location.search);
const initial = params.get("show");
const visible = new Set<CategoryId>(
  initial
    ? (initial.split(",") as CategoryId[]).filter((c) =>
        CATEGORIES.some((x) => x.id === c),
      )
    : CATEGORIES.map((c) => c.id),
);


// 「見え方（平面/3D）」と「表示形式（変化/用途）」は独立した軸にしてある。
// 画面を分けずに済み、視点を保ったまま見たいものを切り替えられる
let palette: "change" | "usage" = "change";

const visibleUsages = new Set<string>(USAGES.map((u) => u.id));

/** 用途で塗る式。選択を外した用途は消さずに中立色へ落とす。
 *  建物が抜けると街の形が崩れて位置が分からなくなるため */
function usageColorExpression(): maplibregl.DataDrivenPropertyValueSpecification<string> {
  const expr: unknown[] = ["match", ["get", "usage"]];
  for (const u of USAGES) {
    expr.push(u.id, visibleUsages.has(u.id) ? u.color : NEUTRAL);
  }
  expr.push(NEUTRAL);
  return expr as maplibregl.DataDrivenPropertyValueSpecification<string>;
}

/** 変化で塗る式。選択を外した分類も同様に中立色へ */
function buildingChangeColor(): maplibregl.DataDrivenPropertyValueSpecification<string> {
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const c of CATEGORIES) {
    expr.push(c.id, visible.has(c.id) ? c.color : NEUTRAL);
  }
  expr.push(NEUTRAL);
  return expr as maplibregl.DataDrivenPropertyValueSpecification<string>;
}

// 背景地図は初期表示から visibility を決めておく。
// 表示しない側のタイルを取りに行かせないため（外部タイルが
// 応答しないとスタイルの読み込みが完了しない）
const initialBasemap = params.get("basemap") ?? "pale";
// setMode からも参照するので、宣言はモジュールの先頭側に置く
let currentBasemap = initialBasemap;
const vis = (kind: string) =>
  (initialBasemap === kind ? "visible" : "none") as "visible" | "none";

/** 年度 t (0=2023, 1=2025) における建物の高さ式。
 *  消える建物は 1→0 に縮み、現れる建物は 0→1 に伸びる。 */
function heightAt(t: number): maplibregl.DataDrivenPropertyValueSpecification<number> {
  const expr = [
    "*",
    ["get", "height"],
    [
      "case",
      ["==", ["get", "year"], 2023], 1 - t,
      ["==", ["get", "status"], "unchanged"], 1,
      t,
    ],
  ];
  return expr as unknown as maplibregl.DataDrivenPropertyValueSpecification<number>;
}

const map = new maplibregl.Map({
  container: "map",
  // MSAA。既定は false で、3Dの建物は斜めの稜線が多いため
  // 切ったままだと輪郭が階段状に見える（MapLibre v5 でここへ移動）
  canvasContextAttributes: { antialias: true },
  // 既定は60度。ビルの間を覗き込む視点まで寝かせられるようにする
  maxPitch: 85,
  // 既定の出典表示を切り、縮尺 → 出典 → 拡大縮小 の順で自分で積む。
  // 下端のコントロールは追加順に下から積まれる
  attributionControl: false,
  hash: true, // ズーム・中心座標を URL ハッシュへ自動同期
  center: [139.653, 35.646],
  zoom: 14,
  style: {
    version: 8,
    sources: {
      pale: {
        type: "raster" as const,
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
      },
      // 判定の正誤を目で確かめるための空中写真。
      // 「なくなった/あらわれた」は建物の有無なので写真と照合できる
      photo: {
        type: "raster" as const,
        tiles: [
          "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
      },
      towns: {
        type: "vector",
        url: "pmtiles://" + location.origin + "/towns.pmtiles",
        attribution:
          '<a href="https://www.e-stat.go.jp/gis">令和2年国勢調査 境界データ</a>',
      },
      landuse: {
        type: "vector",
        url: "pmtiles://" + location.origin + "/landuse.pmtiles",
      },
      trees: {
        type: "vector",
        url: "pmtiles://" + location.origin + "/trees.pmtiles",
      },
      buildings3d: {
        type: "vector",
        url: "pmtiles://" + location.origin + "/buildings3d.pmtiles",
        attribution:
          '<a href="https://www.mlit.go.jp/plateau/">Project PLATEAU</a>',
      },
    },
    sky: {
      "sky-color": "#8ec5ea",
      "sky-horizon-blend": 0.6,
      "horizon-color": "#e8f0f6",
      "horizon-fog-blend": 0.6,
      "fog-color": "#dfe9f0",
      "fog-ground-blend": 0.1,
    },
    light: { anchor: "map", position: [1.6, 235, 55], intensity: 0.42 },
    layers: [
      {
        id: "basemap-pale",
        type: "raster" as const,
        source: "pale",
        layout: { visibility: vis("pale") },
      },
      {
        id: "basemap-photo",
        type: "raster" as const,
        source: "photo",
        layout: { visibility: vis("photo") },
      },
      // --- ここからゲーム風の3D。既定では非表示 ---
      {
        id: "ground",
        type: "background",
        layout: { visibility: "none" as const },
        paint: { "background-color": "#dbe3d3" },
      },
      {
        id: "landuse-fill",
        type: "fill",
        source: "landuse",
        "source-layer": "landuse",
        layout: { visibility: "none" as const },
        paint: {
          "fill-color": [
            "match",
            ["get", "kind"],
            "water", "#8fc7e8",
            "forest", "#6fa361",
            "park", "#8fc47a",
            "farm", "#c9d79a",
            "paddy", "#bcd6a0",
            "nature", "#b7c9a2",
            "vacant", "#e2e0d2",
            "#dfe6d5",
          ],
          "fill-opacity": 0.95,
        },
      },
      {
        id: "town-dim",
        type: "fill",
        source: "towns",
        "source-layer": "towns",
        // 現在地「以外」を覆う。色を足さず明暗だけで領域を示すので、
        // 建物の色分けと喧嘩しない
        filter: ["!=", ["get", "town"], "\u0000"],
        layout: { visibility: "none" as const },
        paint: {
          "fill-color": "#2b2a26",
          "fill-opacity": 0.13,
        },
      },
      {
        id: "town-hairline",
        type: "line",
        source: "towns",
        "source-layer": "towns",
        layout: { visibility: "none" as const, "line-join": "round" as const },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 17, 1.8],
          "line-opacity": 0.75,
        },
      },
      {
        id: "trees-trunk",
        type: "fill-extrusion",
        source: "trees",
        "source-layer": "trees",
        filter: ["==", ["get", "part"], "trunk"],
        layout: { visibility: "none" as const },
        minzoom: 15,
        paint: {
          "fill-extrusion-height": ["*", ["get", "h"], 0.62],
          "fill-extrusion-base": 0,
          "fill-extrusion-color": "#7a5a3c",
        },
      },
      {
        id: "trees-canopy",
        type: "fill-extrusion",
        source: "trees",
        "source-layer": "trees",
        filter: ["==", ["get", "part"], "canopy"],
        layout: { visibility: "none" as const },
        minzoom: 14,
        paint: {
          "fill-extrusion-height": ["get", "h"],
          "fill-extrusion-base": ["*", ["get", "h"], 0.5],
          "fill-extrusion-vertical-gradient": true,
          "fill-extrusion-color": [
            "match",
            ["get", "t"],
            0, "#5b8a52",
            1, "#699a5e",
            "#77aa6a",
          ],
        },
      },
      {
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "buildings3d",
        "source-layer": "buildings",
        layout: { visibility: "none" as const },
        // 変化なしの建物は2023側を捨てる。両年度に同じ形で入っており、
        // 二重に描くと面が重なってちらつくため
        filter: [
          "!",
          ["all", ["==", ["get", "year"], 2023], ["==", ["get", "status"], "unchanged"]],
        ],
        paint: {
          "fill-extrusion-height": heightAt(1),
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 1,
          "fill-extrusion-vertical-gradient": true,
          "fill-extrusion-height-transition": { duration: 1600, delay: 0 },
          "fill-extrusion-color": [
            "match",
            ["get", "status"],
            "appeared", "#4a80c4",
            "changed", "#d99843",
            "gone", "#c4645c",
            "#c8c3ba",
          ],
        },
      },
      {
        id: "buildings-2d",
        type: "fill",
        source: "buildings3d",
        "source-layer": "buildings",
        paint: { "fill-color": NEUTRAL, "fill-opacity": 0.9 },
      },
      {
        id: "buildings-2d-outline",
        type: "line",
        source: "buildings3d",
        "source-layer": "buildings",
        paint: { "line-color": "#ffffff", "line-width": 0.4 },
      },
    ],
  },
});

// 開発時のみ、デバッグ用に地図インスタンスを露出する
if (import.meta.env.DEV) {
  (window as unknown as { map: maplibregl.Map }).map = map;
}

// 読み込み失敗を握り潰さない（タイル欠損は通常運用でも起きる）
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
map.addControl(new maplibregl.NavigationControl(), "bottom-right");

map.on("error", (e) => {
  console.error("[map error]", e.error?.message ?? e);
});


function applyFilter() {
  const year = currentYear();
  const shown = [...visible];

  // その年度に存在する建物だけを残す。
  // 変化なしの建物は2023側にも同じ形で入っているので2025側を採用する
  const yearFilter: unknown[] = [
    "any",
    ["==", ["get", "year"], year],
    ["all", ["==", ["get", "status"], "unchanged"], ["==", ["get", "year"], 2025]],
  ];

  // 選択を外した分類は隠さず中立色に落とす（街の形を保つため）
  const expr: unknown[] =
    shown.length === CATEGORIES.length
      ? ["literal", true]
      : ["any", ["==", ["get", "status"], "unchanged"],
         ["in", ["get", "status"], ["literal", shown]]];

  for (const id of ["buildings-2d", "buildings-2d-outline", "buildings-3d"]) {
    if (map.getLayer(id)) {
      map.setFilter(id, yearFilter as maplibregl.FilterSpecification);
    }
  }
  void expr;
  applyPaletteColors();

  params.set("show", shown.join(","));
  history.replaceState(null, "", `?${params}${location.hash}`);
}

/** 表示形式に応じた選択リストを組み立てる。
 *  変化なら3種、用途なら18種。どちらも選択を外すと中立色に落ちる */
function buildFilters() {
  const box = document.getElementById("filters")!;
  box.innerHTML = "";

  const items =
    palette === "usage"
      ? USAGES.map((u) => ({
          id: u.id as string,
          label: u.label as string,
          color: u.color as string,
          set: visibleUsages,
        }))
      : CATEGORIES.map((c) => ({
          id: c.id as string,
          label: c.label as string,
          color: c.color as string,
          set: visible as Set<string>,
        }));

  for (const item of items) {
    const on = item.set.has(item.id);
    const row = document.createElement("label");
    row.className = "row";
    row.classList.toggle("off", !on);
    row.innerHTML = `
      <input type="checkbox" ${on ? "checked" : ""}>
      <span class="swatch" style="background:${item.color}"></span>
      <span class="label">${item.label}</span>
      <span class="count" data-count="${item.id}"></span>`;
    row.querySelector("input")!.addEventListener("change", (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      checked ? item.set.add(item.id) : item.set.delete(item.id);
      row.classList.toggle("off", !checked);
      applyPaletteColors();
      updateCounts();
    });
    box.appendChild(row);
  }
  updateCounts();
}

/** 詳細パネルの行。値が null の行は出さない */
function detailRows(p: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  const ho = num(p.height_old);
  const hn = num(p.height_new) ?? num(p.measured_height);
  if (ho !== null && hn !== null && ho !== hn) {
    rows.push(["高さ", `${ho} m → ${hn} m`]);
  } else if (hn !== null) {
    rows.push(["高さ", `${hn} m`]);
  }

  const so = num(p.storeys_old);
  const sn = num(p.storeys_new) ?? num(p.storeys_above_ground);
  if (so !== null && sn !== null && so !== sn) {
    rows.push(["階数", `${so}階 → ${sn}階`]);
  } else if (sn !== null) {
    rows.push(["階数", `${sn}階`]);
  }

  if (p.usage) {
    const u = USAGES.find((x) => x.id === String(p.usage));
    rows.push(["用途", u?.label ?? String(p.usage)]);
  }
  if (p.town) rows.push(["町丁目", String(p.town).replace("東京都世田谷区", "")]);
  const fd = num(p.flood_depth);
  if (fd !== null) {
    rows.push(["浸水想定", fd < 0.5 ? `${fd.toFixed(2)} m（軽微）` : `${fd.toFixed(2)} m`]);
  }
  const iou = num(p.iou);
  if (iou !== null) rows.push(["旧建物との重なり", `${(iou * 100).toFixed(0)}%`]);
  return rows;
}

function showDetail(props: Record<string, unknown>) {
  const el = document.getElementById("detail")!;
  const cat = CATEGORIES.find((c) => c.id === props.status);
  const rows = detailRows(props)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");
  el.innerHTML =
    `<h2><span class="dot" style="background:${cat?.color ?? "#c8c3ba"}"></span>` +
    `${cat?.label ?? "変化なし"}</h2>` +
    `<dl>${rows}</dl>` +
    `<p class="note">2023年度と2025年度の建物データの差から見た変化です</p>`;
  el.hidden = false;
}

for (const layer of ["buildings-2d", "buildings-3d"]) {
  map.on("click", layer, (e) => {
    if (e.features?.[0]) showDetail(e.features[0].properties);
  });
  map.on("mouseenter", layer, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layer, () => {
    map.getCanvas().style.cursor = "";
  });
}
// 何もない場所をクリックしたら詳細を閉じる
map.on("click", (e) => {
  const hit = map.queryRenderedFeatures(e.point, {
    layers: ["buildings-2d", "buildings-3d"].filter((l) => map.getLayer(l)),
  });
  if (hit.length === 0) document.getElementById("detail")!.hidden = true;
});

// コンテナのサイズ変更に追従する（初期化時の取りこぼしも拾う）
new ResizeObserver(() => map.resize()).observe(document.getElementById("map")!);

// パネルは地図の読み込み状況と無関係に組み立てる。
// 背景タイルが応答しない場合 load は発火しないため、
// ここを load に依存させると UI ごと死ぬ
buildFilters();
if (map.isStyleLoaded()) {
  applyFilter();
} else {
  map.once("styledata", applyFilter);
}
// 表示範囲内の件数を出す。タイル由来なので概算値
map.on("idle", updateCounts);

function updateCounts() {
  if (!map.getSource("buildings3d") || !map.isSourceLoaded("buildings3d")) return;
  const feats = map.querySourceFeatures("buildings3d", {
    sourceLayer: "buildings",
  });
  const key = palette === "usage" ? "usage" : "status";
  const tally = new Map<string, Set<unknown>>();
  for (const f of feats) {
    const v = String(f.properties?.[key] ?? "");
    if (!tally.has(v)) tally.set(v, new Set());
    tally.get(v)!.add(f.properties?.building_id ?? f.id);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-count]")) {
    const n = tally.get(el.dataset.count ?? "")?.size ?? 0;
    el.textContent = n ? n.toLocaleString() : "";
  }
}

// --- 町丁目別ランキング -------------------------------------------------
// タイルは表示範囲ぶんしか読めないため、区全体の集計は
// パイプラインが書き出した JSON を使う
type TownRow = {
  town: string;
  rate: number;
  total: number;
  new: number;
  rebuilt: number;
  split: number;
  merge: number;
  demolished: number;
  center: [number, number] | null;
};

async function buildRanking() {
  const list = document.getElementById("rank-list")!;
  let rows: TownRow[];
  try {
    const res = await fetch("/towns.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } catch (err) {
    list.innerHTML = `<li>ランキングを読み込めませんでした</li>`;
    console.error("[ranking]", err);
    return;
  }

  localRanking = rows;
  localTowns = rows
    .filter((r) => r.center)
    .map((r) => ({ label: r.town, center: r.center as [number, number] }));

  const max = rows[0]?.rate ?? 1;
  for (const r of rows) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${r.town}</span>
      <span class="rate">${r.rate.toFixed(1)}%</span>
      <span class="meter" style="width:${(r.rate / max) * 100}%"></span>`;
    li.title = `総${r.total}棟 / 新築${r.new} 建替${r.rebuilt} 分割${r.split} 統合${r.merge} 解体${r.demolished}`;
    li.addEventListener("click", () => {
      if (!r.center) return;
      list.querySelectorAll("li.active").forEach((e) =>
        e.classList.remove("active"),
      );
      li.classList.add("active");
      map.flyTo({ center: r.center, zoom: 16, duration: 900 });
    });
    list.appendChild(li);
  }
}

void buildRanking();

// --- 平面／3D の切り替え -------------------------------------------------
// 3D は「分類」ではなく、2023年と2025年の建物そのものを押し出して見比べる。
// 建て替えか解体+新築かはデータからは判定できないため、
// ラベルで断定せず形の変化を直接見せる
const FLAT_LAYERS = ["buildings-2d", "buildings-2d-outline"];
const GAME_LAYERS = [
  "ground",
  "town-dim",
  "town-hairline",
  "landuse-fill",
  "trees-trunk",
  "trees-canopy",
  "buildings-3d",
];

function setMode(mode: string) {
  const is3d = mode === "3d";
  const show = (id: string, on: boolean) =>
    map.setLayoutProperty(id, "visibility", on ? "visible" : "none");

  for (const id of FLAT_LAYERS) show(id, !is3d);
  for (const id of GAME_LAYERS) show(id, is3d);
  // 3Dのときは背景地図を隠す。自前の地面と二重になるため
  show("basemap-pale", !is3d && currentBasemap === "pale");
  show("basemap-photo", !is3d && currentBasemap === "photo");

  // 年度・色分け・絞り込みはすべて両モードで効く。
  // 淡くするのは背景地図だけ（3Dでは自前の地面を使うため）
  document.getElementById("basemaps")!.classList.toggle("inactive", is3d);

  if (is3d) {
    applyYear();
    applyFilter();
    showRotateHint();
    renderLegend();
    if (map.getPitch() < 30) {
      requestAnimationFrame(() =>
        map.easeTo({ pitch: 60, zoom: Math.max(map.getZoom(), 16), duration: 900 }),
      );
    }
  } else {
    renderLegend();
    if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 });
  }
  params.set("mode", mode);
  history.replaceState(null, "", `?${params}${location.hash}`);
}

function currentYear(): number {
  return Number(
    (document.querySelector('input[name="year"]:checked') as HTMLInputElement)
      .value,
  );
}

function applyYear() {
  const year = currentYear();
  if (map.getLayer("buildings-3d")) {
    map.setPaintProperty(
      "buildings-3d",
      "fill-extrusion-height",
      heightAt(year === 2025 ? 1 : 0),
    );
  }
  applyFilter();
  params.set("year", String(year));
  history.replaceState(null, "", `?${params}${location.hash}`);
}

function initModeControls() {
  const savedMode = params.get("mode") === "3d" ? "3d" : "2d";
  const savedYear = params.get("year") === "2023" ? "2023" : "2025";
  for (const el of document.querySelectorAll<HTMLInputElement>(
    'input[name="view"]',
  )) {
    el.checked = el.value === savedMode;
    el.addEventListener("change", () => el.checked && setMode(el.value));
  }
  for (const el of document.querySelectorAll<HTMLInputElement>(
    'input[name="year"]',
  )) {
    el.checked = el.value === savedYear;
    el.addEventListener("change", () => el.checked && applyYear());
  }
  const run = () => setMode(savedMode);
  if (map.isStyleLoaded()) run();
  else map.once("styledata", run);
}

initModeControls();

// --- 背景地図の切り替え ---------------------------------------------------
function setBasemap(kind: string) {
  currentBasemap = kind;
  const show = (id: string, on: boolean) =>
    map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  const flat = params.get("mode") !== "3d";
  show("basemap-pale", flat && kind === "pale");
  show("basemap-photo", flat && kind === "photo");
  // 写真の上では建物の塗りが濃すぎると下が見えないので薄くする
  const onPhoto = kind === "photo";
  if (map.getLayer("buildings-2d")) {
    map.setPaintProperty("buildings-2d", "fill-opacity", onPhoto ? 0.5 : 0.9);
  }
  if (map.getLayer("buildings-2d-outline")) {
    map.setPaintProperty(
      "buildings-2d-outline",
      "line-width",
      onPhoto ? 1 : 0.4,
    );
  }
  params.set("basemap", kind);
  history.replaceState(null, "", `?${params}${location.hash}`);
}

function initBasemap() {
  const saved = initialBasemap;
  for (const el of document.querySelectorAll<HTMLInputElement>(
    'input[name="bm"]',
  )) {
    el.checked = el.value === saved;
    el.addEventListener("change", () => el.checked && setBasemap(el.value));
  }
  const run = () => setBasemap(saved);
  if (map.isStyleLoaded()) run();
  else map.once("styledata", run);
}

initBasemap();

// --- 住所検索 -------------------------------------------------------------
// 国土地理院の住所検索APIで番地まで引ける。町丁目は手元のランキングデータでも
// 補完するので、APIが落ちても最低限は動く
type Hit = { label: string; center: [number, number] };

// 「一丁目・二丁目…」を数値順に並べる。漢数字のままだと辞書順で崩れる
const KANJI: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
/** 「世田谷一丁目」を [町名, 丁目番号] に分ける。丁目が無ければ番号は0 */
function townKey(label: string): [string, number] {
  const m = label.match(/^(.*?)([一二三四五六七八九十]+)丁目$/);
  if (!m) return [label, 0];
  const [, name, num] = m;
  // 十一〜十九、二十〜 の桁上がりを処理する
  let n: number;
  const ten = num.indexOf("十");
  if (ten === -1) {
    n = KANJI[num] ?? 0;
  } else {
    const head = ten === 0 ? 1 : (KANJI[num[ten - 1]] ?? 1);
    const tail = ten === num.length - 1 ? 0 : (KANJI[num[ten + 1]] ?? 0);
    n = head * 10 + tail;
  }
  return [name, n];
}

function compareTown(a: string, b: string): number {
  const [na, ia] = townKey(a);
  const [nb, ib] = townKey(b);
  return na === nb ? ia - ib : na.localeCompare(nb, "ja");
}

const input = document.getElementById("q") as HTMLInputElement;
const suggest = document.getElementById("suggest") as HTMLUListElement;
let localTowns: Hit[] = [];
let localRanking: TownRow[] = [];

function renderSuggest(hits: Hit[]) {
  suggest.innerHTML = "";
  if (hits.length === 0) {
    suggest.hidden = true;
    return;
  }
  for (const h of hits.slice(0, 6)) {
    const li = document.createElement("li");
    li.textContent = h.label;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      map.flyTo({ center: h.center, zoom: 17, pitch: 60, duration: 1400 });
      input.value = h.label;
      suggest.hidden = true;
    });
    suggest.appendChild(li);
  }
  suggest.hidden = false;
}

async function search(q: string) {
  const local = localTowns
    .filter((t) => t.label.includes(q))
    .map((t) => ({ ...t }))
    .sort((a, b) => compareTown(a.label, b.label));

  // 世田谷区のデータしか持っていないので、検索も区内に限定する
  const remote: Hit[] = [];
  const seen = new Set(local.map((h) => h.label));
  try {
    const res = await fetch(
      "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" +
        encodeURIComponent(q.includes("世田谷") ? q : `世田谷区${q}`),
    );
    if (res.ok) {
      const json = (await res.json()) as {
        geometry?: { coordinates?: [number, number] };
        properties?: { title?: string };
      }[];
      for (const f of json) {
        const title = f.properties?.title?.trim();
        const center = f.geometry?.coordinates;
        if (!title || !center || !title.includes("世田谷区")) continue;
        const label = title.replace("東京都世田谷区", "");
        if (!label || seen.has(label)) continue;
        seen.add(label);
        remote.push({ label, center });
      }
    }
  } catch {
    // オフラインや API 障害でも町丁目検索だけは生かす
  }

  const hits = [...local, ...remote];
  renderSuggest(hits);
  if (hits.length === 0) {
    suggest.innerHTML = '<li class="none">世田谷区内で見つかりませんでした</li>';
    suggest.hidden = false;
  }
}

let timer = 0;
input.addEventListener("input", () => {
  const q = input.value.trim();
  window.clearTimeout(timer);
  if (q.length < 1) {
    suggest.hidden = true;
    return;
  }
  timer = window.setTimeout(() => void search(q), 220);
});
input.addEventListener("blur", () => {
  window.setTimeout(() => (suggest.hidden = true), 120);
});

// --- 画面中央がどの町丁目かを常時表示 -------------------------------------
// タイルは表示範囲しか持たないので、判定は軽量な GeoJSON を別に読んで行う
type TownShape = {
  town: string;
  rings: [number, number][][];
};
let shapes: TownShape[] = [];
let currentTown = "";

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function townAt(lng: number, lat: number): string {
  for (const s of shapes) {
    for (const ring of s.rings) {
      if (pointInRing(lng, lat, ring)) return s.town;
    }
  }
  return "";
}

/** レイヤがまだ無い段階でも落ちないようにする */
function setActiveTown(town: string) {
  if (!map.getLayer("town-dim")) return;
  // 現在地以外を覆う。町名が空のときは何も覆わない
  map.setFilter(
    "town-dim",
    town ? ["!=", ["get", "town"], town] : ["==", ["get", "town"], "\u0000"],
  );
}

function updateHere(force = false) {
  if (shapes.length === 0) return;
  const c = map.getCenter();
  const town = townAt(c.lng, c.lat);
  if (town === currentTown && !force) return;
  currentTown = town;

  const el = document.getElementById("here")!;
  if (!town) {
    el.hidden = true;
    setActiveTown("");
    return;
  }
  const rank = localRanking.findIndex((r) => r.town === town);
  const row = rank >= 0 ? localRanking[rank] : null;
  el.querySelector(".name")!.textContent = town;
  el.querySelector(".meta")!.textContent = row
    ? `変化率 ${row.rate.toFixed(1)}%・${rank + 1}位 / ${localRanking.length}`
    : "集計対象外（建物300棟未満）";
  el.hidden = false;

  setActiveTown(town);

  // ランキング側も連動させる
  const list = document.getElementById("rank-list");
  list?.querySelectorAll("li.active").forEach((e) => e.classList.remove("active"));
  if (rank >= 0) {
    const li = list?.children[rank] as HTMLElement | undefined;
    li?.classList.add("active");
    // 閉じた details の中へスクロールするとブラウザが勝手に開いてしまい、
    // 手で閉じられなくなる。開いているときだけ追従させる
    if ((document.getElementById("ranking") as HTMLDetailsElement).open) {
      li?.scrollIntoView({ block: "nearest" });
    }
  }
}

async function loadShapes() {
  try {
    const res = await fetch("/towns-shape.json");
    if (!res.ok) return;
    const fc = (await res.json()) as {
      features: {
        geometry: { type: string; coordinates: number[][][] | number[][][][] };
        properties: { town: string };
      }[];
    };
    shapes = fc.features.map((f) => {
      const g = f.geometry;
      const rings =
        g.type === "Polygon"
          ? [(g.coordinates as number[][][])[0]]
          : (g.coordinates as number[][][][]).map((poly) => poly[0]);
      return {
        town: f.properties.town,
        rings: rings as [number, number][][],
      };
    });
  } catch {
    // 判定用データが無くても地図自体は動く
    return;
  }
  updateHere(true);
}

map.on("moveend", () => updateHere());
// スタイル再構築でフィルタが飛ぶので、そのたびに貼り直す
map.on("styledata", () => updateHere(true));
void loadShapes();

// --- 操作の案内 -----------------------------------------------------------
// 右ドラッグで回せることは言われないと気づかない。3Dに入った初回だけ出す
function showRotateHint() {
  if (localStorage.getItem("machi-diff.rotate-hint") === "seen") return;
  const el = document.createElement("div");
  el.id = "rotate-hint";
  el.textContent = "右ドラッグで回転・傾き";
  document.body.appendChild(el);
  window.setTimeout(() => el.classList.add("fade"), 4200);
  window.setTimeout(() => el.remove(), 5200);
  try {
    localStorage.setItem("machi-diff.rotate-hint", "seen");
  } catch {
    // プライベートウィンドウ等で保存できなくても案内自体は出す
  }
}

// --- 色分けの軸 -----------------------------------------------------------

function applyPaletteColors() {
  const usage = palette === "usage";
  for (const [id, prop] of [
    ["buildings-2d", "fill-color"],
    ["buildings-3d", "fill-extrusion-color"],
  ] as const) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(
      id,
      prop,
      usage
        ? usageColorExpression()
        : buildingChangeColor(),
    );
  }
  // 用途で塗るときは変化の絞り込みが意味を持たないので淡くする
  renderLegend();
}

function applyPalette() {
  buildFilters();
  applyPaletteColors();
  params.set("palette", palette);
  history.replaceState(null, "", `?${params}${location.hash}`);
}

function renderLegend() {
  const box = document.getElementById("legend-body");
  const panel = document.getElementById("legend") as HTMLDetailsElement | null;
  if (!box || !panel) return;
  const is3d =
    document.querySelector<HTMLInputElement>('input[name="view"]:checked')
      ?.value === "3d";

  // 地面の彩色は3Dのときだけ出るので、凡例もそのときだけ意味を持つ
  panel.hidden = !is3d;
  if (!is3d) return;

  box.innerHTML = GROUND_LEGEND.map(
    (g) =>
      `<div class="legend-row"><span class="swatch" style="background:${g.color}"></span>${g.label}</div>`,
  ).join("");
}

function initPalette() {
  const saved = params.get("palette") === "usage" ? "usage" : "change";
  palette = saved;
  for (const el of document.querySelectorAll<HTMLInputElement>(
    'input[name="pal"]',
  )) {
    el.checked = el.value === saved;
    el.addEventListener("change", () => {
      if (!el.checked) return;
      palette = el.value as "change" | "usage";
      applyPalette();
    });
  }
  const run = () => applyPalette();
  if (map.isStyleLoaded()) run();
  else map.once("styledata", run);
}

initPalette();

// --- サイドバーの開閉 -----------------------------------------------------
const toggle = document.getElementById("panel-toggle")!;
toggle.addEventListener("click", () => {
  const closed = document.body.classList.toggle("panel-closed");
  toggle.setAttribute("aria-expanded", String(!closed));
  // 地図の描画領域が変わるのでサイズを取り直す
  window.setTimeout(() => map.resize(), 260);
});
