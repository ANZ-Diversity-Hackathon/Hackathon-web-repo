// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== ENV ======
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";
const AGENT_ID = process.env.BEDROCK_AGENT_ID;          // 必填
const AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS; // 必填
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET;        // 必填
const UPLOAD_PREFIX = process.env.UPLOAD_PREFIX || "chat_uploads/";

// ====== clients ======
const s3 = new S3Client({ region: AWS_REGION });
const br = new BedrockAgentRuntimeClient({ region: AWS_REGION });

// ====== serve static frontend ======
app.use("/", express.static(path.join(__dirname, "public")));

// ====== create presigned url ======
app.post("/api/presign", async (req, res) => {
  try {
    const { filename, contentType, userId } = req.body || {};
    if (!filename || !contentType) {
      return res.status(400).json({ ok: false, error: "filename/contentType required" });
    }
    const safeUser = (userId || "demo").replace(/[^a-zA-Z0-9_-]/g, "");
    const ext = path.extname(filename).toLowerCase() || "";
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const key = `${UPLOAD_PREFIX}${safeUser}/${Date.now()}_${id}${ext}`;

    const cmd = new PutObjectCommand({
      Bucket: UPLOAD_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 }); // 60s
    return res.json({ ok: true, bucket: UPLOAD_BUCKET, key, uploadUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== chat -> invoke agent ======
// sessionId：前端传一个固定的，保持上下文
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};
    if (!message) return res.status(400).json({ ok: false, error: "message required" });

    const agentId = (process.env.BEDROCK_AGENT_ID || "").trim();
    const agentAliasId = (process.env.BEDROCK_AGENT_ALIAS_ID || "").trim();

    console.log("DEBUG ENV:", { agentIdLen: agentId.length, agentAliasIdLen: agentAliasId.length });

    if (!agentId) throw new Error("FATAL: agentId empty at runtime (BEDROCK_AGENT_ID is empty)");
    if (!agentAliasId) throw new Error("FATAL: agentAliasId empty at runtime (BEDROCK_AGENT_ALIAS_ID is empty)");

    const DEMO_USER_ID = process.env.DEMO_USER_ID || "demo";
    const FORCE_DEMO_USER = (process.env.FORCE_DEMO_USER ?? "true").toLowerCase() === "true";
    const cmd = new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId: sessionId || "demo-session",
      inputText: message,
      // ⭐关键：强制所有 action 都以 demo 身份执行
      sessionState: {
        sessionAttributes: {
          user_id: FORCE_DEMO_USER ? DEMO_USER_ID : undefined,
          // 你也可以顺便把 display name 放进去，但不参与分区
          display_user: req.body?.userId || "unknown"
    },
  },

  // 建议先开 trace，方便你确认工具确实被调用
  enableTrace: true,
      
    });

    const resp = await br.send(cmd);

    let text = "";
    if (resp.completion) {
      for await (const ev of resp.completion) {
        const bytes = ev?.chunk?.bytes;
        if (bytes) text += Buffer.from(bytes).toString("utf-8");
      }
    }
    return res.json({ ok: true, text });
  } catch (e) {
    console.error("❌ /api/chat error:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


// ====== start ======
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://0.0.0.0:${port}`));
