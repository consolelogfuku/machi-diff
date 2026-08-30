import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import "./style.css";

// 差分の5分類。順序はそのまま凡例の並びになる
const CATEGORIES = [
  { id: "appeared", label: "あらわれた", color: "#2563eb" },
  { id: "changed", label: "変わった", color: "#f59e0b" },
  { id: "gone", label: "消えた", color: "#dc2626" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

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


/** status -> 色 の match 式。spread ではタプル型が合わないので明示的に組む */
function colorExpression(): maplibregl.DataDrivenPropertyValueSpecification<string> {
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const c of CATEGORIES) expr.push(c.id, c.color);
  expr.push("#999999");
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
 *  消える建物は 1→0 に縮み、現れる建物は 0→1 に伸びる。
 *  paint のトランジションに任せるので毎フレーム更新は不要。 */
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
      changes: {
        type: "vector",
        url: "pmtiles://" + location.origin + "/diff.pmtiles",
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
        id: "town-active-fill",
        type: "fill",
        source: "towns",
        "source-layer": "towns",
        filter: ["==", ["get", "town"], ""],
        layout: { visibility: "none" as const },
        paint: {
          // 塗り分けの上にアクセント色を薄く重ねる。
          // 建物の色を邪魔しない濃さに留める
          "fill-color": "#4a80c4",
          "fill-opacity": 0.14,
        },
      },
      {
        id: "town-hairline",
        type: "line",
        source: "towns",
        "source-layer": "towns",
        layout: { visibility: "none" as const, "line-join": "round" as const },
        paint: {
          "line-color": "#8f9a86",
          "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 17, 1.4],
          "line-opacity": 0.45,
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
        id: "changes-fill",
        type: "fill",
        source: "changes",
        "source-layer": "changes",
        paint: {
          "fill-color": colorExpression(),
          "fill-opacity": 0.75,
        },
      },
      {
        id: "changes-outline",
        type: "line",
        source: "changes",
        "source-layer": "changes",
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
map.on("error", (e) => {
  console.error("[map error]", e.error?.message ?? e);
});

map.addControl(new maplibregl.NavigationControl(), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), "bottom-right");

function applyFilter() {
  const shown = [...visible];
  // 何も選ばれていないときは全部隠す
  const expr: maplibregl.FilterSpecification =
    shown.length === 0
      ? ["==", ["get", "status"], "__none__"]
      : ["in", ["get", "status"], ["literal", shown]];
  map.setFilter("changes-fill", expr);
  map.setFilter("changes-outline", expr);
  // 3D でも同じ絞り込みを効かせる。変化なしの建物は街並みとして常に残す
  if (map.getLayer("buildings-3d")) {
    map.setFilter("buildings-3d", [
      "all",
      [
        "!",
        ["all", ["==", ["get", "year"], 2023], ["==", ["get", "status"], "unchanged"]],
      ],
      ["any", ["==", ["get", "status"], "unchanged"], expr],
    ]);
  }

  params.set("show", shown.join(","));
  history.replaceState(null, "", `?${params}${location.hash}`);
}

function buildPanel() {
  const box = document.getElementById("filters")!;
  for (const c of CATEGORIES) {
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `
      <input type="checkbox" ${visible.has(c.id) ? "checked" : ""}>
      <span class="swatch" style="background:${c.color}"></span>
      <span class="label">${c.label}</span>
      <span class="count" data-count="${c.id}">—</span>`;
    row.querySelector("input")!.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      on ? visible.add(c.id) : visible.delete(c.id);
      row.classList.toggle("off", !on);
      applyFilter();
    });
    row.classList.toggle("off", !visible.has(c.id));
    box.appendChild(row);
  }
}

// 用途コード（Building_usage.xml より）
const USAGE: Record<string, string> = {
  "401": "業務施設", "402": "商業施設", "403": "宿泊施設",
  "404": "商業系複合施設", "411": "住宅", "412": "共同住宅",
  "413": "店舗等併用住宅", "414": "店舗等併用共同住宅",
  "415": "作業所併用住宅", "421": "官公庁施設", "422": "文教厚生施設",
  "431": "運輸倉庫施設", "441": "工場", "451": "農林漁業用施設",
  "452": "供給処理施設", "453": "防衛施設", "454": "その他", "461": "不明",
};

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

  if (p.usage) rows.push(["用途", USAGE[String(p.usage)] ?? String(p.usage)]);
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

for (const layer of ["changes-fill", "buildings-3d"]) {
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
    layers: ["changes-fill", "buildings-3d"].filter((l) => map.getLayer(l)),
  });
  if (hit.length === 0) document.getElementById("detail")!.hidden = true;
});

// コンテナのサイズ変更に追従する（初期化時の取りこぼしも拾う）
new ResizeObserver(() => map.resize()).observe(document.getElementById("map")!);

// パネルは地図の読み込み状況と無関係に組み立てる。
// 背景タイルが応答しない場合 load は発火しないため、
// ここを load に依存させると UI ごと死ぬ
buildPanel();
if (map.isStyleLoaded()) {
  applyFilter();
} else {
  map.once("styledata", applyFilter);
}
// 表示範囲内の件数を出す。タイル由来なので概算値
map.on("idle", updateCounts);

function updateCounts() {
  if (!map.isSourceLoaded("changes")) return;
  const feats = map.querySourceFeatures("changes", { sourceLayer: "changes" });
  const tally = new Map<string, Set<unknown>>();
  for (const f of feats) {
    const s = f.properties?.status as string;
    if (!tally.has(s)) tally.set(s, new Set());
    tally.get(s)!.add(f.properties?.building_id);
  }
  for (const c of CATEGORIES) {
    const el = document.querySelector(`[data-count="${c.id}"]`);
    if (el) el.textContent = (tally.get(c.id)?.size ?? 0).toLocaleString();
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
const FLAT_LAYERS = ["changes-fill", "changes-outline"];
const GAME_LAYERS = [
  "ground",
  "town-hairline",
  "town-active-fill",
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

  // 項目の出し入れはせず、その表示で効かないものだけ淡くする。
  // モードで UI が入れ替わると操作の見当がつかなくなるため
  document.getElementById("years")!.classList.toggle("inactive", !is3d);
  document.getElementById("filters")!.classList.remove("inactive");
  document.getElementById("basemaps")!.classList.toggle("inactive", is3d);

  if (is3d) {
    applyYear();
    applyFilter();
    if (map.getPitch() < 30) {
      requestAnimationFrame(() =>
        map.easeTo({ pitch: 60, zoom: Math.max(map.getZoom(), 16), duration: 900 }),
      );
    }
  } else if (map.getPitch() > 0) {
    map.easeTo({ pitch: 0, duration: 600 });
  }
  params.set("mode", mode);
  history.replaceState(null, "", `?${params}${location.hash}`);
}

function applyYear() {
  const year = Number(
    (document.querySelector('input[name="year"]:checked') as HTMLInputElement)
      .value,
  );
  map.setPaintProperty("buildings-3d", "fill-extrusion-height", heightAt(year === 2025 ? 1 : 0));
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
  map.setPaintProperty("changes-fill", "fill-opacity", onPhoto ? 0.45 : 0.75);
  map.setPaintProperty(
    "changes-outline",
    "line-color",
    onPhoto ? "#ffffff" : "#ffffff",
  );
  map.setPaintProperty("changes-outline", "line-width", onPhoto ? 1.2 : 0.4);
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
type Hit = { label: string; center: [number, number]; sub?: string };

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
    li.innerHTML = `<span>${h.label}</span>${h.sub ? `<em>${h.sub}</em>` : ""}`;
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
    .map((t) => ({ ...t, sub: "町丁目" }));

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
  for (const id of ["town-active-fill"]) {
    if (map.getLayer(id)) {
      map.setFilter(id, ["==", ["get", "town"], town]);
    }
  }
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
    li?.scrollIntoView({ block: "nearest" });
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
