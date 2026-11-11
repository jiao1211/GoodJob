// 产品设计稿：上传产品实拍图 → AI 解析结构 → 生成多套设计方案 → 可选渲染效果图 / 导出设计稿。

type ToastType = "ok" | "error" | "success" | "warn" | "info";

export interface ProductDesignHost {
  api<T>(path: string, init?: RequestInit): Promise<T>;
  toast(message: string, type?: ToastType): void;
  openAiConfig(): void;
  back(): void;
}

interface UploadedImage {
  id: string;
  name: string;
  dataUrl: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
}

interface DesignModel {
  id: string;
  name: string;
  model: string;
  protocol: string;
  usable: boolean;
  imageModel: boolean;
}

interface Swatch { hex: string; name: string; role: string }
interface Zone { part: string; hex: string; colorName: string; material: string }

interface Proposal {
  id: string;
  name: string;
  nameEn: string;
  concept: string;
  targetCustomer: string;
  palette: Swatch[];
  zones: Zone[];
  changes: string[];
  sellingPoints: string[];
  renderPrompt: string;
}

interface Analysis {
  productName: string;
  category: string;
  summary: string;
  components: Array<{ part: string; material: string; color: string }>;
  features: string[];
}

interface DesignResult {
  analysis: Analysis;
  proposals: Proposal[];
  model?: { name: string; model: string };
}

interface RenderState {
  status: "idle" | "loading" | "done" | "error";
  src?: string;
  error?: string;
}

const MAX_IMAGES = 3;
const MAX_EDGE = 1280;
const MAX_DATA_URL_CHARS = 900_000;
const LETTERS = "ABCDEFGHIJ";

const GOALS: Array<{ value: string; label: string; hint: string }> = [
  { value: "colorway", label: "配色方案", hint: "版型不变，只换颜色与面料观感" },
  { value: "branding", label: "品牌定制 OEM", hint: "Logo、织带、拉头、反光条等品牌元素" },
  { value: "upgrade", label: "款式升级", hint: "优化口袋、调节、透气、减重等细节" },
  { value: "mixed", label: "综合方案", hint: "配色 + 品牌 + 适度功能升级" }
];

function esc(value: unknown) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function safeHex(value: string) {
  return /^#[0-9A-F]{6}$/iu.test(value) ? value : "#CBD5E1";
}

function readableInk(hex: string) {
  const value = safeHex(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.58 ? "#111827" : "#ffffff";
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法解析，请换一张 JPG / PNG / WebP"));
    image.src = src;
  });
}

// 浏览器端压缩到长边 1280px 的 JPEG，保证多图请求不超过后端 3 MB 请求体上限。
async function compressImage(file: File): Promise<UploadedImage> {
  if (!/^image\/(png|jpeg|webp)$/u.test(file.type)) {
    throw new Error(`${file.name}：仅支持 PNG、JPG、WebP`);
  }
  const image = await loadImage(await readFileAsDataUrl(file));
  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持图片压缩");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let quality = 0.88;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_DATA_URL_CHARS && quality > 0.45) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    dataUrl,
    mime: "image/jpeg"
  };
}

function proposalText(proposal: Proposal, index: number, analysis: Analysis | null) {
  const lines = [
    `【方案 ${LETTERS[index] || index + 1}】${proposal.name}${proposal.nameEn ? ` / ${proposal.nameEn}` : ""}`,
    analysis ? `产品：${analysis.productName}${analysis.category ? `（${analysis.category}）` : ""}` : "",
    proposal.concept ? `设计理念：${proposal.concept}` : "",
    proposal.targetCustomer ? `适用客户：${proposal.targetCustomer}` : "",
    proposal.palette.length ? `色板：${proposal.palette.map((item) => `${item.name || item.role} ${item.hex}`).join("，")}` : "",
    "部位配色：",
    ...proposal.zones.map((zone) => `  - ${zone.part}：${zone.colorName} ${zone.hex}${zone.material ? `｜${zone.material}` : ""}`),
    proposal.changes.length ? "改动点：" : "",
    ...proposal.changes.map((item) => `  - ${item}`),
    proposal.sellingPoints.length ? "卖点：" : "",
    ...proposal.sellingPoints.map((item) => `  - ${item}`)
  ];
  return lines.filter(Boolean).join("\n");
}

const STYLE = `
#product-design .pd-layout { display:grid; grid-template-columns:minmax(300px,360px) minmax(0,1fr); gap:16px; align-items:start; }
#product-design .pd-side { position:sticky; top:12px; display:grid; gap:14px; }
#product-design .pd-drop { border:1.5px dashed var(--line,#d6dfdd); border-radius:var(--radius,8px); padding:18px 14px; text-align:center; background:var(--surface-2,#f4f7f7); cursor:pointer; transition:border-color .15s, background .15s; }
#product-design .pd-drop:hover, #product-design .pd-drop.is-over { border-color:var(--brand,#be123c); background:var(--brand-tint,#fdecee); }
#product-design .pd-drop svg { width:30px; height:30px; stroke:var(--brand,#be123c); fill:none; stroke-width:1.6; }
#product-design .pd-drop b { display:block; margin-top:6px; color:var(--ink,#10211f); }
#product-design .pd-drop small { color:var(--muted,#6a7975); }
#product-design .pd-thumbs { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; }
#product-design .pd-thumb { position:relative; aspect-ratio:1; border-radius:6px; overflow:hidden; border:1px solid var(--line,#e1e8e6); background:#fff; }
#product-design .pd-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
#product-design .pd-thumb button { position:absolute; top:4px; right:4px; width:22px; height:22px; border-radius:50%; border:0; background:rgba(15,23,42,.72); color:#fff; cursor:pointer; line-height:22px; padding:0; }
#product-design .pd-thumb .pd-main-tag { position:absolute; left:4px; bottom:4px; font-size:11px; background:var(--brand,#be123c); color:#fff; border-radius:4px; padding:1px 5px; }
#product-design .pd-form { display:grid; gap:10px; }
#product-design .pd-form label { display:block; font-size:12px; color:var(--muted,#6a7975); margin-bottom:4px; font-weight:600; }
#product-design .pd-form input, #product-design .pd-form select, #product-design .pd-form textarea { width:100%; box-sizing:border-box; font:inherit; font-size:13px; color:var(--ink,#10211f); background:var(--surface,#fff); border:1px solid var(--line,#e1e8e6); border-radius:var(--radius-sm,6px); padding:8px 10px; min-height:36px; outline:none; transition:border-color .15s, box-shadow .15s; }
#product-design .pd-form textarea { resize:vertical; line-height:1.5; }
#product-design .pd-form input::placeholder, #product-design .pd-form textarea::placeholder { color:#9aa4b5; }
#product-design .pd-form input:focus, #product-design .pd-form select:focus, #product-design .pd-form textarea:focus { border-color:var(--brand,#be123c); box-shadow:0 0 0 3px var(--brand-ring,rgba(190,18,60,.18)); }
#product-design .pd-goals { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
#product-design .pd-goal { border:1px solid var(--line,#e1e8e6); border-radius:6px; padding:8px; cursor:pointer; background:var(--surface,#fff); text-align:left; }
#product-design .pd-goal b { display:block; font-size:13px; color:var(--ink,#10211f); }
#product-design .pd-goal small { font-size:11px; color:var(--muted,#6a7975); line-height:1.35; display:block; margin-top:2px; }
#product-design .pd-goal.is-active { border-color:var(--brand,#be123c); box-shadow:0 0 0 3px var(--brand-ring,rgba(190,18,60,.18)); }
#product-design .pd-row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
#product-design .pd-generate { width:100%; justify-content:center; padding:11px; font-size:15px; }
#product-design .pd-model-hint { font-size:12px; color:var(--muted,#6a7975); line-height:1.5; }
#product-design .pd-model-hint a { color:var(--brand,#be123c); cursor:pointer; text-decoration:underline; }
#product-design .pd-main { display:grid; gap:16px; min-width:0; }
#product-design .pd-empty { padding:56px 24px; text-align:center; color:var(--muted,#6a7975); }
#product-design .pd-empty h2 { color:var(--ink,#10211f); margin:10px 0 6px; font-size:18px; }
#product-design .pd-steps { display:flex; justify-content:center; gap:10px; flex-wrap:wrap; margin-top:16px; }
#product-design .pd-steps span { background:var(--surface-2,#f4f7f7); border:1px solid var(--line,#e1e8e6); border-radius:999px; padding:5px 12px; font-size:12px; }
#product-design .pd-loading { padding:48px 24px; text-align:center; color:var(--muted,#6a7975); }
#product-design .pd-spinner { width:34px; height:34px; border-radius:50%; border:3px solid var(--line,#e1e8e6); border-top-color:var(--brand,#be123c); animation:pdSpin .9s linear infinite; margin:0 auto 12px; }
@keyframes pdSpin { to { transform:rotate(360deg); } }
#product-design .pd-analysis-grid { display:grid; grid-template-columns:120px minmax(0,1fr); gap:14px; }
#product-design .pd-analysis-grid > img { width:120px; height:120px; object-fit:cover; border-radius:8px; border:1px solid var(--line,#e1e8e6); }
#product-design .pd-analysis h3 { margin:0 0 4px; font-size:17px; color:var(--ink,#10211f); }
#product-design .pd-analysis p { margin:0 0 10px; color:var(--text,#2b3a36); line-height:1.6; font-size:13px; }
#product-design .pd-chips { display:flex; flex-wrap:wrap; gap:6px; }
#product-design .pd-chip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line,#e1e8e6); border-radius:999px; padding:3px 10px 3px 4px; font-size:12px; background:var(--surface,#fff); }
#product-design .pd-chip i { width:16px; height:16px; border-radius:50%; border:1px solid rgba(0,0,0,.12); flex:none; }
#product-design .pd-chip.plain { padding-left:10px; }
#product-design .pd-toolbar { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
#product-design .pd-toolbar h2 { margin:0; font-size:16px; }
#product-design .pd-sheets { display:grid; grid-template-columns:repeat(auto-fill,minmax(440px,1fr)); gap:16px; }
#product-design .pd-sheet { background:var(--surface,#fff); border:1px solid var(--line,#e1e8e6); border-radius:10px; overflow:hidden; box-shadow:var(--shadow-soft,0 6px 20px rgba(16,33,31,.06)); display:flex; flex-direction:column; }
#product-design .pd-sheet-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:14px 16px 10px; border-bottom:1px solid var(--line-soft,#eef3f2); }
#product-design .pd-sheet-head h3 { margin:2px 0 0; font-size:16px; color:var(--ink,#10211f); }
#product-design .pd-sheet-head small { color:var(--muted,#6a7975); font-size:12px; }
#product-design .pd-letter { display:inline-block; font-size:11px; font-weight:700; letter-spacing:.06em; color:#fff; background:var(--ink,#10211f); border-radius:4px; padding:2px 7px; }
#product-design .pd-sheet-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
#product-design .pd-sheet-body { padding:14px 16px 16px; display:grid; gap:12px; }
#product-design .pd-visuals { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
#product-design .pd-visuals figure { margin:0; }
#product-design .pd-visuals figcaption { font-size:11px; color:var(--muted,#6a7975); margin-bottom:4px; font-weight:600; }
#product-design .pd-frame { aspect-ratio:1; border-radius:8px; overflow:hidden; border:1px solid var(--line,#e1e8e6); background:#f3f4f6; position:relative; }
#product-design .pd-frame > img { width:100%; height:100%; object-fit:contain; display:block; background:#fff; }
#product-design .pd-blocks { position:absolute; inset:0; display:flex; flex-direction:column; }
#product-design .pd-blocks div { flex:1; display:flex; align-items:center; padding:0 10px; font-size:11px; font-weight:600; }
#product-design .pd-frame-note { position:absolute; left:8px; right:8px; bottom:8px; background:rgba(255,255,255,.92); color:#334155; border-radius:6px; font-size:11px; padding:6px 8px; text-align:center; line-height:1.4; }
#product-design .pd-frame-note.error { color:#b91c1c; }
#product-design .pd-frame .pd-spinner { position:absolute; top:calc(50% - 30px); left:calc(50% - 17px); margin:0; }
#product-design .pd-palette { display:flex; border-radius:8px; overflow:hidden; border:1px solid var(--line,#e1e8e6); }
#product-design .pd-palette div { flex:1; padding:18px 8px 7px; font-size:11px; line-height:1.3; min-width:0; }
#product-design .pd-palette b { display:block; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#product-design .pd-concept { margin:0; font-size:13px; line-height:1.65; color:var(--text,#2b3a36); }
#product-design .pd-concept em { font-style:normal; color:var(--muted,#6a7975); display:block; margin-top:4px; font-size:12px; }
#product-design .pd-zones { width:100%; border-collapse:collapse; font-size:12px; }
#product-design .pd-zones th { text-align:left; color:var(--muted,#6a7975); font-weight:600; padding:6px 6px; border-bottom:1px solid var(--line,#e1e8e6); }
#product-design .pd-zones td { padding:6px; border-bottom:1px solid var(--line-soft,#eef3f2); vertical-align:top; }
#product-design .pd-zones td:first-child { font-weight:600; color:var(--ink,#10211f); white-space:nowrap; }
#product-design .pd-color { display:inline-flex; align-items:center; gap:6px; }
#product-design .pd-color i { width:14px; height:14px; border-radius:3px; border:1px solid rgba(0,0,0,.15); flex:none; }
#product-design .pd-color code { font-size:11px; color:var(--muted,#6a7975); }
#product-design .pd-lists { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
#product-design .pd-lists h4 { margin:0 0 6px; font-size:12px; color:var(--muted,#6a7975); }
#product-design .pd-lists ul { margin:0; padding-left:16px; font-size:12px; line-height:1.6; color:var(--text,#2b3a36); }
#product-design .pd-foot { font-size:11px; color:var(--muted,#6a7975); text-align:right; }
@media (max-width: 1100px) {
  #product-design .pd-layout { grid-template-columns:1fr; }
  #product-design .pd-side { position:static; }
}
@media (max-width: 560px) {
  #product-design .pd-sheets { grid-template-columns:1fr; }
  #product-design .pd-visuals, #product-design .pd-lists { grid-template-columns:1fr; }
  #product-design .pd-analysis-grid { grid-template-columns:1fr; }
}
`;

export function mountProductDesign(root: HTMLElement, host: ProductDesignHost) {
  if (!document.getElementById("productDesignStyles")) {
    const style = document.createElement("style");
    style.id = "productDesignStyles";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  if (root.dataset.pdMounted === "1") {
    void refreshModels();
    return;
  }
  root.dataset.pdMounted = "1";

  let images: UploadedImage[] = [];
  let goal = "colorway";
  let models: DesignModel[] = [];
  let result: DesignResult | null = null;
  let generating = false;
  let generationError = "";
  const renders = new Map<string, RenderState>();

  root.innerHTML = `
    <div class="page-head">
      <div><h1>产品设计稿</h1><span class="view-sub">上传产品实拍图，AI 解析结构后生成多套可打样的设计方案，并可渲染效果图、导出设计稿</span></div>
      <div class="head-actions"><button class="btn" data-tool-back type="button">返回工具</button><button class="btn" type="button" data-pd-config>AI配置</button></div>
    </div>
    <div class="pd-layout">
      <aside class="pd-side">
        <section class="panel section">
          <div class="section-head"><div class="section-title"><div><h2>1. 上传产品图</h2></div></div></div>
          <div class="pd-drop" data-pd-drop tabindex="0" role="button" aria-label="上传产品图片">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>
            <b>点击或拖入产品图片</b>
            <small>最多 ${MAX_IMAGES} 张（正面 / 背面 / 细节），第一张为主图</small>
          </div>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden data-pd-file>
          <div class="pd-thumbs" data-pd-thumbs></div>
        </section>
        <section class="panel section">
          <div class="section-head"><div class="section-title"><div><h2>2. 设计要求</h2></div></div></div>
          <div class="pd-form">
            <div>
              <label>设计方向</label>
              <div class="pd-goals" data-pd-goals>
                ${GOALS.map((item) => `<button type="button" class="pd-goal${item.value === goal ? " is-active" : ""}" data-goal="${item.value}"><b>${item.label}</b><small>${item.hint}</small></button>`).join("")}
              </div>
            </div>
            <div class="pd-row2">
              <div><label for="pdMarket">目标市场 / 客群</label><input id="pdMarket" maxlength="120" placeholder="如：欧美越野跑女性"></div>
              <div><label for="pdCount">方案数量</label><select id="pdCount">${[2, 3, 4, 5, 6].map((count) => `<option value="${count}"${count === 3 ? " selected" : ""}>${count} 套</option>`).join("")}</select></div>
            </div>
            <div><label for="pdStyle">风格关键词</label><input id="pdStyle" maxlength="200" placeholder="如：轻量、高可见度、马卡龙、竞速感"></div>
            <div><label for="pdBrand">品牌 / Logo 文字（可选）</label><input id="pdBrand" maxlength="60" placeholder="客户品牌名，用于 Logo 位置设计"></div>
            <div><label for="pdConstraints">必须保留 / 限制（可选）</label><textarea id="pdConstraints" rows="2" maxlength="300" placeholder="如：保留现有版型和弹力绳结构，成本不增加"></textarea></div>
          </div>
        </section>
        <section class="panel section">
          <div class="section-head"><div class="section-title"><div><h2>3. 模型</h2></div></div></div>
          <div class="pd-form">
            <div><label for="pdVisionModel">方案生成（视觉模型）</label><select id="pdVisionModel"></select></div>
            <div><label for="pdImageModel">效果图渲染（图像模型，可选）</label><select id="pdImageModel"></select></div>
            <p class="pd-model-hint" data-pd-model-hint></p>
            <button class="btn primary pd-generate" type="button" data-pd-generate>生成设计方案</button>
          </div>
        </section>
      </aside>
      <div class="pd-main" data-pd-main></div>
    </div>`;

  const fileInput = root.querySelector<HTMLInputElement>("[data-pd-file]")!;
  const drop = root.querySelector<HTMLElement>("[data-pd-drop]")!;
  const thumbs = root.querySelector<HTMLElement>("[data-pd-thumbs]")!;
  const main = root.querySelector<HTMLElement>("[data-pd-main]")!;
  const visionSelect = root.querySelector<HTMLSelectElement>("#pdVisionModel")!;
  const imageSelect = root.querySelector<HTMLSelectElement>("#pdImageModel")!;
  const modelHint = root.querySelector<HTMLElement>("[data-pd-model-hint]")!;
  const generateButton = root.querySelector<HTMLButtonElement>("[data-pd-generate]")!;
  const field = (id: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)!;

  root.querySelector("[data-pd-config]")?.addEventListener("click", () => host.openAiConfig());
  root.querySelector("[data-tool-back]")?.addEventListener("click", () => host.back());
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); }
  });
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("is-over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
    void addFiles(Array.from(event.dataTransfer?.files || []));
  });
  fileInput.addEventListener("change", () => {
    void addFiles(Array.from(fileInput.files || []));
    fileInput.value = "";
  });
  thumbs.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
    if (!id) return;
    images = images.filter((item) => item.id !== id);
    renderThumbs();
  });
  root.querySelector("[data-pd-goals]")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-goal]");
    if (!button) return;
    goal = button.dataset.goal || "colorway";
    root.querySelectorAll<HTMLElement>("[data-goal]").forEach((node) => node.classList.toggle("is-active", node === button));
  });
  generateButton.addEventListener("click", () => void generate());
  imageSelect.addEventListener("change", renderModelHint);
  visionSelect.addEventListener("change", renderModelHint);
  modelHint.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-pd-open-config]")) host.openAiConfig();
  });
  main.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const id = target.dataset.id || "";
    if (target.dataset.action === "render") void renderProposal(id);
    if (target.dataset.action === "render-all") void renderAll();
    if (target.dataset.action === "download") void downloadSheet(id);
    if (target.dataset.action === "copy") void copyProposal(id);
    if (target.dataset.action === "regenerate") void generate();
  });

  renderThumbs();
  renderMain();
  void refreshModels();

  async function addFiles(files: File[]) {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      host.toast(`最多上传 ${MAX_IMAGES} 张图片，请先移除一张`, "warn");
      return;
    }
    if (files.length > room) host.toast(`最多 ${MAX_IMAGES} 张，已取前 ${room} 张`, "warn");
    for (const file of files.slice(0, room)) {
      try {
        images.push(await compressImage(file));
      } catch (error) {
        host.toast(error instanceof Error ? error.message : "图片处理失败", "error");
      }
    }
    renderThumbs();
  }

  function renderThumbs() {
    thumbs.innerHTML = images.map((item, index) => `
      <div class="pd-thumb" title="${esc(item.name)}">
        <img src="${item.dataUrl}" alt="${esc(item.name)}">
        <button type="button" data-remove="${item.id}" aria-label="移除">×</button>
        ${index === 0 ? `<span class="pd-main-tag">主图</span>` : ""}
      </div>`).join("");
    thumbs.hidden = images.length === 0;
  }

  async function refreshModels() {
    try {
      const data = await host.api<{ configs: DesignModel[]; defaultVisionId: string | null; defaultImageId: string | null }>("/api/tools/product-design/models");
      models = data.configs || [];
      const previousVision = visionSelect.value;
      const previousImage = imageSelect.value;
      const option = (item: DesignModel) => `<option value="${esc(item.id)}"${item.usable ? "" : " disabled"}>${esc(item.name || item.model)} · ${esc(item.model)}${item.usable ? "" : "（未启用）"}</option>`;
      visionSelect.innerHTML = models.length
        ? models.filter((item) => !item.imageModel).concat(models.filter((item) => item.imageModel)).map(option).join("")
        : `<option value="">未配置模型</option>`;
      imageSelect.innerHTML = `<option value="">不渲染（只出设计方案）</option>`
        + models.filter((item) => item.protocol !== "anthropic").map(option).join("");
      const pick = (select: HTMLSelectElement, previous: string, fallback: string | null) => {
        const value = [previous, fallback || ""].find((candidate) => candidate && models.some((item) => item.id === candidate && item.usable));
        if (value) select.value = value;
      };
      pick(visionSelect, previousVision, data.defaultVisionId);
      pick(imageSelect, previousImage, data.defaultImageId);
    } catch (error) {
      visionSelect.innerHTML = `<option value="">模型列表加载失败</option>`;
      imageSelect.innerHTML = `<option value="">不渲染（只出设计方案）</option>`;
      host.toast(error instanceof Error ? error.message : "模型列表加载失败", "error");
    }
    renderModelHint();
  }

  function renderModelHint() {
    const usable = models.filter((item) => item.usable);
    if (!usable.length) {
      modelHint.innerHTML = `还没有可用的 AI 模型。<a data-pd-open-config>前往 AI 配置</a>添加支持图片输入的模型（如 gpt-4o、Claude、Gemini、通义千问 VL）。`;
      return;
    }
    modelHint.innerHTML = imageSelect.value
      ? "生成方案后可一键渲染效果图：以主图为参考，保持结构只换配色和细节。"
      : `未选择图像模型时只输出设计方案和色板。想要效果图，可在 <a data-pd-open-config>AI 配置</a> 添加 gpt-image-1、gemini-2.5-flash-image 或豆包 Seedream。`;
  }

  function brief() {
    return {
      goal,
      targetMarket: field("pdMarket").value.trim(),
      styleKeywords: field("pdStyle").value.trim(),
      brandName: field("pdBrand").value.trim(),
      constraints: field("pdConstraints").value.trim(),
      variantCount: Number(field("pdCount").value) || 3
    };
  }

  async function generate() {
    if (generating) return;
    if (!images.length) {
      host.toast("请先上传至少一张产品图片", "warn");
      drop.focus();
      return;
    }
    if (!visionSelect.value) {
      host.toast("请先在 AI 配置中添加并启用一个视觉模型", "warn");
      return;
    }
    generating = true;
    generationError = "";
    generateButton.disabled = true;
    generateButton.textContent = "正在生成…";
    renderMain();
    try {
      result = await host.api<DesignResult>("/api/tools/product-design/proposals", {
        method: "POST",
        body: JSON.stringify({
          images: images.map((item) => ({ image: item.dataUrl, mime: item.mime })),
          configId: visionSelect.value || undefined,
          brief: brief()
        })
      });
      renders.clear();
      host.toast(`已生成 ${result.proposals.length} 套设计方案`, "success");
    } catch (error) {
      generationError = error instanceof Error ? error.message : "设计方案生成失败";
      host.toast(generationError, "error");
    } finally {
      generating = false;
      generateButton.disabled = false;
      generateButton.textContent = "生成设计方案";
      renderMain();
    }
  }

  function renderMain() {
    if (generating) {
      main.innerHTML = `<section class="panel section pd-loading"><div class="pd-spinner"></div><b>AI 正在解析产品结构并设计方案…</b><p>通常需要 20–60 秒，请勿关闭页面</p></section>`;
      return;
    }
    if (!result) {
      main.innerHTML = `
        <section class="panel section pd-empty">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z"/></svg>
          <h2>${generationError ? "生成失败" : "上传产品，生成设计稿"}</h2>
          <p>${generationError ? esc(generationError) : "适合 OEM 打样提案：给客户看配色、品牌定制和款式升级方案"}</p>
          <div class="pd-steps"><span>① 上传实拍图</span><span>② 选设计方向</span><span>③ AI 出方案 + 色卡</span><span>④ 渲染效果图 / 导出</span></div>
        </section>`;
      return;
    }
    const { analysis, proposals } = result;
    main.innerHTML = `
      <section class="panel section pd-analysis">
        <div class="section-head"><div class="section-title"><div><h2>产品解析</h2></div></div>${result.model ? `<span class="badge">${esc(result.model.name || result.model.model)}</span>` : ""}</div>
        <div class="pd-analysis-grid">
          ${images[0] ? `<img src="${images[0].dataUrl}" alt="主图">` : ""}
          <div>
            <h3>${esc(analysis.productName)}${analysis.category ? ` <small style="font-weight:400;color:var(--muted)">· ${esc(analysis.category)}</small>` : ""}</h3>
            ${analysis.summary ? `<p>${esc(analysis.summary)}</p>` : ""}
            <div class="pd-chips">${analysis.components.map((item) => `<span class="pd-chip${item.color ? "" : " plain"}">${item.color ? `<i style="background:${safeHex(item.color)}"></i>` : ""}${esc(item.part)}${item.material ? ` · ${esc(item.material)}` : ""}</span>`).join("")}</div>
            ${analysis.features.length ? `<div class="pd-chips" style="margin-top:8px">${analysis.features.map((item) => `<span class="pd-chip plain">${esc(item)}</span>`).join("")}</div>` : ""}
          </div>
        </div>
      </section>
      <div class="pd-toolbar">
        <h2>设计方案 · ${proposals.length} 套</h2>
        <div class="head-actions">
          <button class="btn" type="button" data-action="regenerate">重新生成</button>
          <button class="btn primary" type="button" data-action="render-all"${imageSelect.value ? "" : " disabled title=\"请先选择图像模型\""}>全部渲染效果图</button>
        </div>
      </div>
      <div class="pd-sheets">${proposals.map((proposal, index) => sheetHtml(proposal, index)).join("")}</div>`;
  }

  function renderSlotHtml(proposal: Proposal) {
    const state = renders.get(proposal.id) || { status: "idle" };
    if (state.status === "done" && state.src) {
      return `<img src="${esc(state.src)}" alt="${esc(proposal.name)} 效果图" crossorigin="anonymous">`;
    }
    const blocks = (proposal.zones.length ? proposal.zones : proposal.palette.map((item) => ({ part: item.role || item.name, hex: item.hex, colorName: item.name, material: "" })))
      .filter((zone) => zone.hex)
      .slice(0, 6)
      .map((zone) => `<div style="background:${safeHex(zone.hex)};color:${readableInk(zone.hex)}">${esc(zone.part)}</div>`)
      .join("");
    const note = state.status === "loading"
      ? `<div class="pd-spinner"></div><div class="pd-frame-note">效果图渲染中，约 20–90 秒…</div>`
      : state.status === "error"
        ? `<div class="pd-frame-note error">${esc(state.error || "渲染失败")}</div>`
        : `<div class="pd-frame-note">部位色块预览${imageSelect.value ? " · 点击「生成效果图」" : " · 选择图像模型后可渲染"}</div>`;
    return `<div class="pd-blocks">${blocks}</div>${note}`;
  }

  function sheetHtml(proposal: Proposal, index: number) {
    const state = renders.get(proposal.id);
    const letter = LETTERS[index] || String(index + 1);
    return `
      <article class="pd-sheet" data-sheet="${proposal.id}">
        <header class="pd-sheet-head">
          <div>
            <span class="pd-letter">方案 ${letter}</span>
            <h3>${esc(proposal.name)}</h3>
            ${proposal.nameEn ? `<small>${esc(proposal.nameEn)}</small>` : ""}
          </div>
          <div class="pd-sheet-actions" data-export-ignore>
            <button class="btn tiny" type="button" data-action="copy" data-id="${proposal.id}">复制文案</button>
            <button class="btn tiny" type="button" data-action="download" data-id="${proposal.id}">下载设计稿</button>
            <button class="btn tiny primary" type="button" data-action="render" data-id="${proposal.id}"${!imageSelect.value || state?.status === "loading" ? " disabled" : ""}>${state?.status === "done" ? "重新渲染" : "生成效果图"}</button>
          </div>
        </header>
        <div class="pd-sheet-body">
          <div class="pd-visuals">
            <figure><figcaption>原样品</figcaption><div class="pd-frame">${images[0] ? `<img src="${images[0].dataUrl}" alt="原样品">` : ""}</div></figure>
            <figure><figcaption>${state?.status === "done" ? "AI 效果图" : "新方案"}</figcaption><div class="pd-frame" data-render-slot="${proposal.id}">${renderSlotHtml(proposal)}</div></figure>
          </div>
          ${proposal.palette.length ? `<div class="pd-palette">${proposal.palette.map((item) => `<div style="background:${safeHex(item.hex)};color:${readableInk(item.hex)}"><b>${esc(item.name || item.role)}</b>${esc(item.hex)}${item.role ? ` · ${esc(item.role)}` : ""}</div>`).join("")}</div>` : ""}
          ${proposal.concept || proposal.targetCustomer ? `<p class="pd-concept">${esc(proposal.concept)}${proposal.targetCustomer ? `<em>适用：${esc(proposal.targetCustomer)}</em>` : ""}</p>` : ""}
          ${proposal.zones.length ? `
            <table class="pd-zones">
              <thead><tr><th>部位</th><th>颜色</th><th>材质 / 工艺</th></tr></thead>
              <tbody>${proposal.zones.map((zone) => `<tr><td>${esc(zone.part)}</td><td><span class="pd-color"><i style="background:${safeHex(zone.hex)}"></i>${esc(zone.colorName)} <code>${esc(zone.hex)}</code></span></td><td>${esc(zone.material)}</td></tr>`).join("")}</tbody>
            </table>` : ""}
          ${proposal.changes.length || proposal.sellingPoints.length ? `
            <div class="pd-lists">
              <div><h4>改动点</h4><ul>${proposal.changes.map((item) => `<li>${esc(item)}</li>`).join("") || "<li>保持原结构</li>"}</ul></div>
              <div><h4>卖点</h4><ul>${proposal.sellingPoints.map((item) => `<li>${esc(item)}</li>`).join("") || "<li>—</li>"}</ul></div>
            </div>` : ""}
          <div class="pd-foot">${esc(result?.analysis.productName || "")} · 方案 ${letter} · ${new Date().toLocaleDateString("zh-CN")}</div>
        </div>
      </article>`;
  }

  function rerenderSheet(id: string) {
    if (!result) return;
    const index = result.proposals.findIndex((item) => item.id === id);
    const node = main.querySelector<HTMLElement>(`[data-sheet="${CSS.escape(id)}"]`);
    if (index < 0 || !node) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = sheetHtml(result.proposals[index], index).trim();
    node.replaceWith(wrapper.firstElementChild as HTMLElement);
  }

  async function renderProposal(id: string) {
    const proposal = result?.proposals.find((item) => item.id === id);
    if (!proposal || !images[0]) return;
    if (!imageSelect.value) {
      host.toast("请先在左侧选择图像模型", "warn");
      return;
    }
    if (renders.get(id)?.status === "loading") return;
    renders.set(id, { status: "loading" });
    rerenderSheet(id);
    try {
      const data = await host.api<{ imageDataUrl?: string; imageUrl?: string }>("/api/tools/product-design/render", {
        method: "POST",
        body: JSON.stringify({
          image: images[0].dataUrl,
          mime: images[0].mime,
          configId: imageSelect.value,
          brandName: field("pdBrand").value.trim(),
          proposal
        })
      });
      const src = data.imageDataUrl || data.imageUrl;
      if (!src) throw new Error("图像模型没有返回图片");
      renders.set(id, { status: "done", src });
    } catch (error) {
      const message = error instanceof Error ? error.message : "效果图生成失败";
      renders.set(id, { status: "error", error: message });
      host.toast(message, "error");
    }
    rerenderSheet(id);
  }

  async function renderAll() {
    if (!result) return;
    if (!imageSelect.value) {
      host.toast("请先在左侧选择图像模型", "warn");
      return;
    }
    // 逐个渲染，避免触发图像模型的并发限流。
    for (const proposal of result.proposals) {
      if (renders.get(proposal.id)?.status === "done") continue;
      await renderProposal(proposal.id);
    }
  }

  async function copyProposal(id: string) {
    if (!result) return;
    const index = result.proposals.findIndex((item) => item.id === id);
    if (index < 0) return;
    try {
      await navigator.clipboard.writeText(proposalText(result.proposals[index], index, result.analysis));
      host.toast("方案文案已复制，可直接发给客户或工厂", "success");
    } catch {
      host.toast("浏览器不允许访问剪贴板", "error");
    }
  }

  async function downloadSheet(id: string) {
    const node = main.querySelector<HTMLElement>(`[data-sheet="${CSS.escape(id)}"]`);
    const proposal = result?.proposals.find((item) => item.id === id);
    if (!node || !proposal) return;
    try {
      const { toPng } = await import("html-to-image");
      const png = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        filter: (element) => !(element instanceof HTMLElement && element.hasAttribute("data-export-ignore"))
      });
      const link = document.createElement("a");
      link.href = png;
      link.download = `${(result?.analysis.productName || "产品").replace(/[\\/:*?"<>|]+/gu, "")}-${proposal.name.replace(/[\\/:*?"<>|]+/gu, "")}-设计稿.png`;
      link.click();
    } catch {
      host.toast("设计稿导出失败：外链效果图可能不允许导出，可右键另存效果图", "error");
    }
  }
}
