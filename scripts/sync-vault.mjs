#!/usr/bin/env node
// Sync published Obsidian notes into Astro content collection.
// Reads VAULT_PATH env var, filters notes with `publish: true` frontmatter,
// rewrites wikilinks/embeds, copies attachments, removes orphans.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Tiny .env loader (no dep). Only sets keys not already in process.env.
for (const envFile of [".env.local", ".env"]) {
    const p = path.join(ROOT, envFile);
    if (!fsSync.existsSync(p)) continue;
    const text = fsSync.readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        const key = m[1];
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
    }
}
const BLOG_OUT = path.join(ROOT, "src/content/blog");
const ASSETS_OUT = path.join(ROOT, "public/vault-assets");
const MANIFEST = path.join(BLOG_OUT, ".vault-sync.json");

const vaultPath = process.env.VAULT_PATH;

if (!vaultPath) {
    console.log("[sync-vault] VAULT_PATH not set, skipping.");
    process.exit(0);
}

try {
    await fs.access(vaultPath);
} catch {
    console.log(`[sync-vault] VAULT_PATH not found (${vaultPath}), skipping.`);
    process.exit(0);
}

await fs.mkdir(BLOG_OUT, { recursive: true });
await fs.mkdir(ASSETS_OUT, { recursive: true });

const slugify = (s) =>
    s
        .toString()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "untitled";

const mdFiles = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    ignore: ["**/.obsidian/**", "**/.trash/**", "**/node_modules/**"],
});

// Pass 1: collect publishable notes and build name → slug map.
const published = [];
const noteIndex = new Map(); // lowercase note name (no ext) → slug

for (const file of mdFiles) {
    const raw = await fs.readFile(file, "utf8");
    let parsed;
    try {
        parsed = matter(raw);
    } catch (err) {
        console.warn(`[sync-vault] frontmatter parse failed: ${file} — ${err.message}`);
        continue;
    }
    if (parsed.data?.publish !== true) continue;

    const baseName = path.basename(file, ".md");
    const title = parsed.data.title || baseName;
    const slug = parsed.data.slug ? slugify(parsed.data.slug) : slugify(baseName);

    if (noteIndex.has(baseName.toLowerCase())) {
        console.warn(`[sync-vault] duplicate note name "${baseName}" — wikilinks will resolve to the first one`);
    } else {
        noteIndex.set(baseName.toLowerCase(), slug);
    }

    published.push({ file, raw, parsed, baseName, title, slug });
}

// Build an attachment index: filename (lowercase) → absolute path.
// Obsidian embeds reference attachments by basename, not path.
const attachmentFiles = await fg("**/*.{png,jpg,jpeg,gif,svg,webp,pdf,mp4,webm}", {
    cwd: vaultPath,
    absolute: true,
    ignore: ["**/.obsidian/**", "**/.trash/**"],
    caseSensitiveMatch: false,
});
const attachmentIndex = new Map();
for (const f of attachmentFiles) {
    attachmentIndex.set(path.basename(f).toLowerCase(), f);
}

const usedAttachments = new Set();

const resolveDate = (data, fallback) => {
    const candidate = data.pubDate || data.date || data.created || fallback;
    if (!candidate) return new Date().toISOString().slice(0, 10);
    if (candidate instanceof Date) return candidate.toISOString().slice(0, 10);
    return String(candidate).slice(0, 10);
};

const transformBody = (body) => {
    // Embeds: ![[file.ext]] or ![[file.ext|alt]]
    body = body.replace(/!\[\[([^\]|#]+?)(?:\|([^\]]+))?\]\]/g, (m, target, alt) => {
        const name = target.trim();
        const ext = path.extname(name).toLowerCase();
        if (ext && attachmentIndex.has(name.toLowerCase())) {
            usedAttachments.add(name.toLowerCase());
            const safe = encodeURIComponent(name);
            return `![${alt || name}](/vault-assets/${safe})`;
        }
        // Note transclusion — v1: render as a link
        const key = path.basename(name, path.extname(name)).toLowerCase();
        const slug = noteIndex.get(key);
        if (slug) return `[${alt || name}](/blog/${slug}/)`;
        return `*(embed: ${name})*`;
    });

    // Wikilinks: [[Note]] or [[Note|alias]] or [[Note#heading]]
    body = body.replace(/\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (m, target, heading, alias) => {
        const key = target.trim().toLowerCase();
        const slug = noteIndex.get(key);
        const label = alias || target.trim();
        if (!slug) return label; // unresolved → strip brackets
        const hash = heading ? `#${slugify(heading)}` : "";
        return `[${label}](/blog/${slug}/${hash})`;
    });

    return body;
};

// Pass 2: write outputs.
const writtenFiles = [];
for (const note of published) {
    const { parsed, baseName, title, slug } = note;
    const description = parsed.data.description || parsed.data.summary;
    const pubDate = resolveDate(parsed.data, null);
    const updatedDate = parsed.data.updatedDate || parsed.data.updated;
    const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags : undefined;

    const newFrontmatter = { title, pubDate };
    if (description) newFrontmatter.description = description;
    if (updatedDate) newFrontmatter.updatedDate = String(updatedDate).slice(0, 10);
    if (tags) newFrontmatter.tags = tags;
    if (parsed.data.heroImage) newFrontmatter.heroImage = parsed.data.heroImage;

    const body = transformBody(parsed.content);
    const out = matter.stringify(body, newFrontmatter);

    const outPath = path.join(BLOG_OUT, `${slug}.md`);
    await fs.writeFile(outPath, out, "utf8");
    writtenFiles.push(path.relative(BLOG_OUT, outPath));
    console.log(`[sync-vault] wrote ${slug}.md (from "${baseName}")`);
}

// Copy used attachments.
for (const name of usedAttachments) {
    const src = attachmentIndex.get(name);
    if (!src) continue;
    const dest = path.join(ASSETS_OUT, path.basename(src));
    await fs.copyFile(src, dest);
}

// Clean orphans using manifest.
let prev = { files: [], assets: [] };
try {
    prev = JSON.parse(await fs.readFile(MANIFEST, "utf8"));
} catch {}

const writtenSet = new Set(writtenFiles);
for (const rel of prev.files || []) {
    if (!writtenSet.has(rel)) {
        try {
            await fs.unlink(path.join(BLOG_OUT, rel));
            console.log(`[sync-vault] removed orphan ${rel}`);
        } catch {}
    }
}

const writtenAssets = [...usedAttachments].map((n) =>
    path.basename(attachmentIndex.get(n))
);
const writtenAssetSet = new Set(writtenAssets);
for (const rel of prev.assets || []) {
    if (!writtenAssetSet.has(rel)) {
        try {
            await fs.unlink(path.join(ASSETS_OUT, rel));
        } catch {}
    }
}

await fs.writeFile(
    MANIFEST,
    JSON.stringify({ files: writtenFiles, assets: writtenAssets }, null, 2)
);

console.log(`[sync-vault] done — ${published.length} note(s), ${usedAttachments.size} attachment(s).`);
