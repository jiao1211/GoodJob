import { createAiHttpClient, createAiImageHttpClient } from "./ai-http-security.js";
import {
  aiHttpErrorMessage,
  extractJsonObject,
  readAiJson
} from "./ai-model-runtime.js";
import type { AiModelConfig } from "./types.js";

// 产品设计稿：上传产品实拍图 → 视觉模型解析产品结构 → 生成多套设计方案（配色/材质/功能/卖点）
// → 可选调用图像模型，以原图为参考渲染每套方案的效果图。

export type ProductDesignImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ProductDesignImage {
  buffer: Buffer;
  mime: ProductDesignImageMime;
}

export const PRODUCT_DESIGN_GOALS = ["colorway", "branding", "upgrade", "mixed"] as const;
export type ProductDesignGoal = typeof PRODUCT_DESIGN_GOALS[number];

export interface ProductDesignBrief {
  goal: ProductDesignGoal;
  targetMarket: string;
  styleKeywords: string;
  brandName: string;
  constraints: string;
  variantCount: number;
}

export interface ProductDesignComponent {
  part: string;
  material: string;
  color: string;
}

export interface ProductDesignAnalysis {
  productName: string;
  category: string;
  summary: string;
  components: ProductDesignComponent[];
  features: string[];
}

export interface ProductDesignSwatch {
  hex: string;
  name: string;
  role: string;
}

export interface ProductDesignZone {
  part: string;
  hex: string;
  colorName: string;
  material: string;
}

export interface ProductDesignProposal {
  id: string;
  name: string;
  nameEn: string;
  concept: string;
  targetCustomer: string;
  palette: ProductDesignSwatch[];
  zones: ProductDesignZone[];
  changes: string[];
  sellingPoints: string[];
  renderPrompt: string;
}

export interface ProductDesignResult {
  analysis: ProductDesignAnalysis;
  proposals: ProductDesignProposal[];
}

export interface ProductDesignRender {
  imageDataUrl?: string;
  imageUrl?: string;
}

type DesignFetcher = (url: string, init?: RequestInit) => Promise<globalThis.Response>;

const PROPOSAL_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 180_000;
export const PRODUCT_DESIGN_MAX_IMAGES = 3;
export const PRODUCT_DESIGN_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const GOAL_LABELS: Record<ProductDesignGoal, string> = {
  colorway: "配色方案：保持版型和结构不变，只改变各部位颜色与面料观感",
  branding: "品牌定制（OEM）：在保持结构的前提下设计 Logo 位置、织带/拉头/反光条等品牌元素和配色",
  upgrade: "款式升级：在现有结构上优化功能细节（口袋、调节、透气、反光、减重等）并给出配色",
  mixed: "综合方案：配色 + 品牌元素 + 适度功能升级"
};

export function decodeProductDesignImage(image: string, declaredMime: ProductDesignImageMime): ProductDesignImage {
  const encoded = image.includes(",") ? image.slice(image.indexOf(",") + 1) : image;
  if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/u.test(encoded)) {
    throw new Error("产品图片 Base64 格式无效");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > PRODUCT_DESIGN_MAX_IMAGE_BYTES) {
    throw new Error("单张产品图片大小必须在 2 MB 以内");
  }
  const png = buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp = buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const actual: ProductDesignImageMime | "" = png ? "image/png" : jpeg ? "image/jpeg" : webp ? "image/webp" : "";
  if (!actual || actual !== declaredMime) {
    throw new Error("图片内容与声明格式不一致，仅支持真实 PNG、JPEG 或 WebP");
  }
  return { buffer, mime: actual };
}

function dataUrl(image: ProductDesignImage) {
  return `data:${image.mime};base64,${image.buffer.toString("base64")}`;
}

function text(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function textList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

export function normalizeHex(value: unknown) {
  const raw = String(value ?? "").trim().replace(/^#/u, "");
  if (/^[0-9a-f]{6}$/iu.test(raw)) return `#${raw.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/iu.test(raw)) {
    return `#${raw.split("").map((char) => char + char).join("").toUpperCase()}`;
  }
  return "";
}

function records(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

export function normalizeProductDesignBrief(input: Partial<ProductDesignBrief>): ProductDesignBrief {
  const goal = PRODUCT_DESIGN_GOALS.includes(input.goal as ProductDesignGoal) ? input.goal as ProductDesignGoal : "colorway";
  const count = Math.round(Number(input.variantCount) || 3);
  return {
    goal,
    targetMarket: text(input.targetMarket, 120),
    styleKeywords: text(input.styleKeywords, 200),
    brandName: text(input.brandName, 60),
    constraints: text(input.constraints, 300),
    variantCount: Math.max(1, Math.min(6, count))
  };
}

export function buildProductDesignPrompt(brief: ProductDesignBrief, imageCount: number) {
  return [
    `你是资深的户外/运动/消费品工业设计师和外贸 OEM 打样顾问。用户上传了 ${imageCount} 张同一款产品的实拍图。`,
    "第一步：只根据图片中能看到的内容，识别产品品类、结构部位（主体、肩带、侧片、网布、织带、抽绳、拉链、包边、反光条、扣件等）、每个部位当前的颜色和材质，以及功能特征。看不清的不要编造。",
    `第二步：按照设计方向生成 ${brief.variantCount} 套差异明显、可直接打样的设计方案。`,
    `设计方向：${GOAL_LABELS[brief.goal]}。`,
    brief.targetMarket ? `目标市场/客群：${brief.targetMarket}。` : "",
    brief.styleKeywords ? `风格关键词：${brief.styleKeywords}。` : "",
    brief.brandName ? `品牌/Logo 文字：${brief.brandName}（在方案中说明 Logo 的位置、工艺和颜色）。` : "",
    brief.constraints ? `必须保留/限制条件：${brief.constraints}。` : "",
    "要求：",
    "- 每套方案的 zones 必须覆盖第一步识别到的主要部位，hex 为 #RRGGBB；颜色名称用中文并附潘通参考色号（如可判断）。",
    "- palette 为 3-5 个主辅色；changes 写清相对原样品的具体改动（部位 + 改法 + 工艺）；sellingPoints 写给外贸客户看的卖点。",
    "- renderPrompt 用英文写给图像生成模型：以原图为参考，保持产品结构、视角和比例不变，逐个部位描述新颜色/材质/Logo，白色无缝棚拍背景，商业产品摄影。",
    "- 方案之间要有明确区分（例如：经典耐脏、高可见度、女性柔和、竞速黑科技、品牌联名等）。",
    "只返回一个 JSON 对象，不要 Markdown 和解释，格式：",
    JSON.stringify({
      analysis: {
        productName: "产品中文名",
        category: "品类",
        summary: "一句话描述结构与定位",
        components: [{ part: "部位", material: "材质", color: "#RRGGBB" }],
        features: ["功能特征"]
      },
      proposals: [{
        name: "方案中文名",
        nameEn: "Colorway English Name",
        concept: "设计理念 1-2 句",
        targetCustomer: "适合的客户/市场",
        palette: [{ hex: "#RRGGBB", name: "颜色名", role: "主色/辅色/点缀色" }],
        zones: [{ part: "部位", hex: "#RRGGBB", colorName: "颜色名", material: "材质/工艺" }],
        changes: ["具体改动"],
        sellingPoints: ["卖点"],
        renderPrompt: "English prompt for image model"
      }]
    })
  ].filter(Boolean).join("\n");
}

export function parseProductDesignResult(content: string, maxProposals = 6): ProductDesignResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(content);
  } catch {
    throw new Error("模型没有返回可用的设计方案，请确认当前模型支持图片输入后重试");
  }
  const rawAnalysis = parsed.analysis && typeof parsed.analysis === "object" && !Array.isArray(parsed.analysis)
    ? parsed.analysis as Record<string, unknown>
    : {};
  const analysis: ProductDesignAnalysis = {
    productName: text(rawAnalysis.productName, 80) || "未命名产品",
    category: text(rawAnalysis.category, 60),
    summary: text(rawAnalysis.summary, 400),
    components: records(rawAnalysis.components).map((item) => ({
      part: text(item.part, 40),
      material: text(item.material, 80),
      color: normalizeHex(item.color)
    })).filter((item) => item.part).slice(0, 16),
    features: textList(rawAnalysis.features, 12, 120)
  };
  const proposals = records(parsed.proposals).map((item, index): ProductDesignProposal => {
    const palette = records(item.palette).map((swatch) => ({
      hex: normalizeHex(swatch.hex),
      name: text(swatch.name, 40),
      role: text(swatch.role, 20)
    })).filter((swatch) => swatch.hex).slice(0, 6);
    const zones = records(item.zones).map((zone) => ({
      part: text(zone.part, 40),
      hex: normalizeHex(zone.hex),
      colorName: text(zone.colorName, 60),
      material: text(zone.material, 100)
    })).filter((zone) => zone.part).slice(0, 16);
    return {
      id: `p${index + 1}`,
      name: text(item.name, 40) || `方案 ${index + 1}`,
      nameEn: text(item.nameEn, 60),
      concept: text(item.concept, 400),
      targetCustomer: text(item.targetCustomer, 160),
      palette: palette.length ? palette : zones.filter((zone) => zone.hex).slice(0, 4).map((zone) => ({
        hex: zone.hex,
        name: zone.colorName,
        role: zone.part
      })),
      zones,
      changes: textList(item.changes, 10, 200),
      sellingPoints: textList(item.sellingPoints, 8, 160),
      renderPrompt: text(item.renderPrompt, 1_500)
    };
  }).filter((proposal) => proposal.zones.length || proposal.palette.length).slice(0, maxProposals);
  if (!proposals.length) {
    throw new Error("模型未生成有效的设计方案，请更换更清晰的产品图或调整设计要求后重试");
  }
  return { analysis, proposals };
}

function contentText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => contentText(item)).filter(Boolean).join("\n");
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  return contentText(item.text) || contentText(item.value) || contentText(item.content);
}

function visionResponseText(data: unknown, protocol: string) {
  const root = data && typeof data === "object" ? data as Record<string, any> : {};
  if (protocol === "anthropic") return contentText(root.content);
  if (protocol === "gemini") return contentText(root.candidates?.[0]?.content?.parts);
  const choice = root.choices?.[0];
  return contentText(choice?.message?.content) || contentText(choice?.text) || contentText(root.output_text);
}

function friendlyError(error: unknown, timeoutMessage: string) {
  const status = Number((error as { httpStatus?: unknown })?.httpStatus || 0);
  if (status >= 400) {
    const upstream = String((error as { upstreamMessage?: unknown })?.upstreamMessage || "").trim();
    return new Error(upstream ? `${aiHttpErrorMessage(status)}（${upstream.slice(0, 200)}）` : aiHttpErrorMessage(status));
  }
  const message = error instanceof Error ? error.message : String(error);
  if ((error instanceof Error && error.name === "AbortError") || /aborted|timeout|ETIMEDOUT/iu.test(message)) {
    return new Error(timeoutMessage);
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed/iu.test(message)) {
    return new Error("连接不到模型服务：请检查接口地址是否正确、网络是否能访问该服务（海外服务可能需要代理）");
  }
  if (/certificate|CERT_|SSL|TLS/iu.test(message)) {
    return new Error("与模型服务建立安全连接失败（证书校验未通过），请检查网络代理或接口地址");
  }
  return error instanceof Error ? error : new Error(message);
}

export async function generateProductDesignProposals(
  images: ProductDesignImage[],
  briefInput: Partial<ProductDesignBrief>,
  config: AiModelConfig,
  fetcher?: DesignFetcher
): Promise<ProductDesignResult> {
  if (!images.length) throw new Error("请至少上传一张产品图片");
  const brief = normalizeProductDesignBrief(briefInput);
  const usedImages = images.slice(0, PRODUCT_DESIGN_MAX_IMAGES);
  const endpointBase = config.baseUrl.replace(/\/+$/, "");
  const protocol = config.protocol || "openai-compatible";
  const client = fetcher ? null : createAiHttpClient(endpointBase);
  const request = fetcher || ((url: string, init?: RequestInit) => client!.fetch(url, init));
  const prompt = buildProductDesignPrompt(brief, usedImages.length);
  const system = "你是产品设计顾问，只输出严格 JSON。";

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  if (protocol === "anthropic") {
    url = endpointBase.toLowerCase().endsWith("/messages") ? endpointBase : `${endpointBase}/messages`;
    headers = { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    body = {
      model: config.model,
      max_tokens: 6_000,
      temperature: 0.7,
      system,
      messages: [{
        role: "user",
        content: [
          ...usedImages.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mime, data: image.buffer.toString("base64") }
          })),
          { type: "text", text: prompt }
        ]
      }]
    };
  } else if (protocol === "gemini") {
    url = `${endpointBase}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers = { "content-type": "application/json", "x-goog-api-key": config.apiKey };
    body = {
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
      contents: [{
        role: "user",
        parts: [
          ...usedImages.map((image) => ({ inline_data: { mime_type: image.mime, data: image.buffer.toString("base64") } })),
          { text: `${system}\n${prompt}` }
        ]
      }]
    };
  } else {
    url = endpointBase.toLowerCase().endsWith("/chat/completions") ? endpointBase : `${endpointBase}/chat/completions`;
    headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
    body = {
      model: config.model,
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...usedImages.map((image) => ({ type: "image_url", image_url: { url: dataUrl(image) } }))
          ]
        }
      ]
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROPOSAL_TIMEOUT_MS);
  try {
    const response = await request(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    });
    const data = await readAiJson<unknown>(response);
    const content = visionResponseText(data, protocol).trim();
    if (!content) throw new Error("视觉模型返回为空，请确认当前模型支持图片输入");
    return parseProductDesignResult(content, brief.variantCount);
  } catch (error) {
    throw friendlyError(error, "设计方案生成超时，请减少方案数量或更换响应更快的视觉模型");
  } finally {
    clearTimeout(timeout);
  }
}

const IMAGE_MODEL_PATTERN = /(gpt-image|dall-?e|imagen|image-preview|flash-image|-image\b|seedream|seededit|cogview|wanx|wan2|flux|kolors|stable-diffusion|sdxl|hidream|qwen-image|jimeng)/iu;

export function looksLikeImageModel(config: Pick<AiModelConfig, "model" | "name">) {
  return IMAGE_MODEL_PATTERN.test(config.model || "") || /图像|生图|绘图|image/iu.test(config.name || "");
}

export function buildRenderPrompt(proposal: ProductDesignProposal, brandName = "") {
  const zones = proposal.zones
    .map((zone) => `${zone.part}: ${zone.colorName || ""} ${zone.hex}${zone.material ? `, ${zone.material}` : ""}`)
    .join("; ");
  return [
    proposal.renderPrompt,
    "Redesign the product in the reference photo. Keep exactly the same product type, structure, silhouette, proportions, camera angle and all functional details (straps, cords, toggles, pockets, mesh).",
    zones ? `Apply this colorway per part — ${zones}.` : "",
    proposal.changes.length ? `Design changes: ${proposal.changes.join("; ")}.` : "",
    brandName ? `Brand logo text "${brandName}" placed as described, clean and legible.` : "",
    "Remove background clutter; place the product on a clean seamless light-grey studio background with soft shadows. Professional e-commerce product photography, high detail, realistic fabric texture. No people, no extra text."
  ].filter(Boolean).join("\n").slice(0, 3_800);
}

function multipartBody(fields: Array<{ name: string; value: string } | { name: string; filename: string; mime: string; data: Buffer }>) {
  const boundary = `----goodjob-design-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("data" in field) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\nContent-Type: ${field.mime}\r\n\r\n`));
      chunks.push(field.data);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` };
}

function openAiImageResult(data: unknown): ProductDesignRender {
  const root = data && typeof data === "object" ? data as Record<string, any> : {};
  const first = Array.isArray(root.data) ? root.data[0] : null;
  if (first?.b64_json) return { imageDataUrl: `data:image/png;base64,${String(first.b64_json)}` };
  if (typeof first?.url === "string" && /^https:\/\//iu.test(first.url)) return { imageUrl: first.url };
  throw new Error("图像模型没有返回图片，请确认所选模型支持图生图");
}

function geminiImageResult(data: unknown): ProductDesignRender {
  const root = data && typeof data === "object" ? data as Record<string, any> : {};
  const parts: any[] = root.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mime = String(inline.mimeType || inline.mime_type || "image/png");
      return { imageDataUrl: `data:${/^image\/(png|jpeg|webp)$/u.test(mime) ? mime : "image/png"};base64,${String(inline.data)}` };
    }
  }
  throw new Error("Gemini 没有返回图片，请使用支持图片输出的模型（如 gemini-2.5-flash-image）");
}

export async function renderProductDesignImage(
  image: ProductDesignImage,
  proposal: ProductDesignProposal,
  config: AiModelConfig,
  options: { brandName?: string } = {},
  fetcher?: DesignFetcher
): Promise<ProductDesignRender> {
  const protocol = config.protocol || "openai-compatible";
  if (protocol === "anthropic") {
    throw new Error("Claude 协议不支持生成图片，请在「AI配置」中添加图像模型（如 gpt-image-1、gemini-2.5-flash-image、豆包 Seedream）");
  }
  const endpointBase = config.baseUrl.replace(/\/+$/, "");
  const client = fetcher ? null : createAiImageHttpClient(endpointBase);
  const request = fetcher || ((url: string, init?: RequestInit) => client!.fetch(url, init));
  const prompt = buildRenderPrompt(proposal, options.brandName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    if (protocol === "gemini") {
      const response = await request(`${endpointBase}/models/${encodeURIComponent(config.model)}:generateContent`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          contents: [{
            role: "user",
            parts: [
              { inline_data: { mime_type: image.mime, data: image.buffer.toString("base64") } },
              { text: prompt }
            ]
          }]
        })
      });
      return geminiImageResult(await readAiJson<unknown>(response));
    }
    if (/seedream|seededit/iu.test(config.model)) {
      // 火山方舟 Seedream：/images/generations 支持以 Base64 Data URL 传入参考图。
      const response = await request(`${endpointBase}/images/generations`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          prompt,
          image: dataUrl(image),
          size: "2K",
          response_format: "b64_json",
          watermark: false
        })
      });
      return openAiImageResult(await readAiJson<unknown>(response));
    }
    const extension = image.mime === "image/png" ? "png" : image.mime === "image/webp" ? "webp" : "jpg";
    const form = multipartBody([
      { name: "model", value: config.model },
      { name: "prompt", value: prompt },
      { name: "n", value: "1" },
      { name: "size", value: "1024x1024" },
      { name: "image", filename: `product.${extension}`, mime: image.mime, data: image.buffer }
    ]);
    const response = await request(`${endpointBase}/images/edits`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": form.contentType },
      body: form.body
    });
    return openAiImageResult(await readAiJson<unknown>(response));
  } catch (error) {
    throw friendlyError(error, "效果图渲染超时，请稍后重试或更换图像模型");
  } finally {
    clearTimeout(timeout);
  }
}
