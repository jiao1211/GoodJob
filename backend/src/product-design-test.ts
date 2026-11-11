import assert from "node:assert/strict";
import {
  buildRenderPrompt,
  decodeProductDesignImage,
  generateProductDesignProposals,
  looksLikeImageModel,
  normalizeHex,
  normalizeProductDesignBrief,
  parseProductDesignResult,
  renderProductDesignImage
} from "./product-design.js";
import type { AiModelConfig } from "./types.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const image = decodeProductDesignImage(`data:image/jpeg;base64,${jpeg.toString("base64")}`, "image/jpeg");
assert.equal(image.mime, "image/jpeg");
assert.throws(() => decodeProductDesignImage(jpeg.toString("base64"), "image/png"), /不一致/u);
assert.throws(() => decodeProductDesignImage("not base64!!", "image/jpeg"), /Base64/u);

assert.equal(normalizeHex("#7b6fd0"), "#7B6FD0");
assert.equal(normalizeHex("abc"), "#AABBCC");
assert.equal(normalizeHex("purple"), "");

const brief = normalizeProductDesignBrief({ goal: "nope" as never, variantCount: 42, brandName: "  TrailX  " });
assert.equal(brief.goal, "colorway");
assert.equal(brief.variantCount, 6);
assert.equal(brief.brandName, "TrailX");

const modelReply = "```json\n" + JSON.stringify({
  analysis: {
    productName: "越野跑水袋背心",
    category: "跑步背包",
    summary: "前胸弹力绳 + 双侧网袋",
    components: [{ part: "主体", material: "弹力布", color: "#7b6fd0" }, { part: "", color: "#000" }],
    features: ["弹力绳收纳", "反光织带"]
  },
  proposals: [
    {
      name: "暗夜竞速",
      nameEn: "Night Racer",
      concept: "黑色主体配荧光点缀",
      palette: [{ hex: "#111111", name: "曜石黑", role: "主色" }, { hex: "not-a-color", name: "x" }],
      zones: [{ part: "主体", hex: "#111111", colorName: "曜石黑", material: "弹力布" }],
      changes: ["抽绳改为荧光绿"],
      sellingPoints: ["夜跑高可见"],
      renderPrompt: "black vest with neon green cords"
    },
    { name: "空方案" },
    {
      name: "薰衣草",
      zones: [{ part: "主体", hex: "#C4B5FD", colorName: "薰衣草紫" }]
    }
  ]
}) + "\n```";
const parsed = parseProductDesignResult(modelReply, 3);
assert.equal(parsed.analysis.components.length, 1);
assert.equal(parsed.analysis.components[0].color, "#7B6FD0");
assert.equal(parsed.proposals.length, 2, "proposals without colors are dropped");
assert.equal(parsed.proposals[0].palette.length, 1, "invalid swatches are dropped");
assert.equal(parsed.proposals[1].palette[0].hex, "#C4B5FD", "palette falls back to zone colors");
assert.throws(() => parseProductDesignResult("sorry, I cannot see images"), /设计方案/u);

assert.equal(looksLikeImageModel({ model: "gpt-image-1", name: "" }), true);
assert.equal(looksLikeImageModel({ model: "gemini-2.5-flash-image", name: "" }), true);
assert.equal(looksLikeImageModel({ model: "doubao-seedream-4-0-250828", name: "" }), true);
assert.equal(looksLikeImageModel({ model: "gpt-4o-mini", name: "OpenAI 业务模型" }), false);

const prompt = buildRenderPrompt(parsed.proposals[0], "TrailX");
assert.match(prompt, /主体: 曜石黑 #111111/u);
assert.match(prompt, /TrailX/u);

function config(overrides: Partial<AiModelConfig>): AiModelConfig {
  return {
    id: "ai1",
    provider: "openai",
    protocol: "openai-compatible",
    name: "test",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o",
    apiKey: "sk-test",
    enabled: true,
    temperature: 0.2,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: true,
    ownerId: "u1",
    teamId: "t1",
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" }
});

// OpenAI-compatible vision call sends every image as image_url.
let captured: { url: string; body: any } | null = null;
const result = await generateProductDesignProposals([image, image], { variantCount: 2 }, config({}), async (url, init) => {
  captured = { url, body: JSON.parse(String(init?.body)) };
  return jsonResponse({ choices: [{ message: { content: modelReply } }] });
});
assert.equal(result.proposals.length, 2);
assert.equal(captured!.url, "https://api.example.com/v1/chat/completions");
const userContent = captured!.body.messages[1].content;
assert.equal(userContent.filter((part: any) => part.type === "image_url").length, 2);
assert.match(userContent[0].text, /生成 2 套/u);

// Anthropic vision call uses base64 image blocks.
await generateProductDesignProposals([image], {}, config({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" }), async (url, init) => {
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  const body = JSON.parse(String(init?.body));
  assert.equal(body.messages[0].content[0].type, "image");
  return jsonResponse({ content: [{ type: "text", text: modelReply }] });
});

// Upstream HTTP errors become readable messages.
await assert.rejects(
  generateProductDesignProposals([image], {}, config({}), async () => new Response(JSON.stringify({ error: { message: "bad key" } }), {
    status: 401,
    headers: { "content-type": "application/json" }
  })),
  /认证失败/u
);

// OpenAI image edit uses multipart with the reference image.
const rendered = await renderProductDesignImage(image, parsed.proposals[0], config({ model: "gpt-image-1" }), {}, async (url, init) => {
  assert.equal(url, "https://api.example.com/v1/images/edits");
  const headers = init?.headers as Record<string, string>;
  assert.match(headers["content-type"], /^multipart\/form-data; boundary=/u);
  const payload = Buffer.from(init?.body as Uint8Array).toString("latin1");
  assert.match(payload, /name="image"; filename="product.jpg"/u);
  assert.match(payload, /name="model"\r\n\r\ngpt-image-1/u);
  return jsonResponse({ data: [{ b64_json: "aGVsbG8=" }] });
});
assert.equal(rendered.imageDataUrl, "data:image/png;base64,aGVsbG8=");

// Seedream goes through /images/generations with a data URL reference.
await renderProductDesignImage(image, parsed.proposals[0], config({ model: "doubao-seedream-4-0-250828", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }), {}, async (url, init) => {
  assert.equal(url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
  const body = JSON.parse(String(init?.body));
  assert.match(body.image, /^data:image\/jpeg;base64,/u);
  return jsonResponse({ data: [{ url: "https://cdn.example.com/out.png" }] });
}).then((value) => assert.equal(value.imageUrl, "https://cdn.example.com/out.png"));

// Gemini returns inline image data.
const geminiRender = await renderProductDesignImage(image, parsed.proposals[0], config({ protocol: "gemini", model: "gemini-2.5-flash-image", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }), {}, async (url, init) => {
  assert.match(url, /models\/gemini-2\.5-flash-image:generateContent$/u);
  assert.deepEqual(JSON.parse(String(init?.body)).generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  return jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: "aW1n" } }] } }] });
});
assert.equal(geminiRender.imageDataUrl, "data:image/png;base64,aW1n");

await assert.rejects(
  renderProductDesignImage(image, parsed.proposals[0], config({ protocol: "anthropic" }), {}, async () => jsonResponse({})),
  /不支持生成图片/u
);

console.log("product-design tests passed");
