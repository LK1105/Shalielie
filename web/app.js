import { loadProfile } from "./src/zip.js";
import { patch, selectProfile, VERSION, UNSUPPORTED } from "./src/port.js";
import { discoverHeic } from "./src/heif.js";
import { addTexture, hasTexture } from "./src/texture.js";
import { decodeToRgb, loadLibheif } from "./src/decode.js";
import { pickLanguage, rememberLanguage, applyLanguage, t } from "./src/i18n.js";

const $ = (id) => document.getElementById(id);
const fileInput = $("file"), drop = $("drop"), list = $("list"), quality = $("quality");

let lang = pickLanguage();
const T = (key) => t(lang, key);

// Inside the iOS shell this page runs in a WKWebView with the app's local
// PhotoOriginal plugin registered. Choosing from the Photo Library through
// <input type=file> there hands back a JPEG that iOS transcoded on the way in —
// which is exactly the data this tool rewrites — so the app reads the original
// bytes through PhotoKit instead. The file input stays available as a second
// way in, for photos that live in the Files app.
//
// In a browser none of this exists and every path below behaves as before.
const native = (() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  if (cap.Plugins && cap.Plugins.PhotoOriginal) return cap.Plugins.PhotoOriginal;
  try {
    return cap.registerPlugin("PhotoOriginal");
  } catch (e) {
    console.warn("PhotoOriginal plugin is not registered:", e);
    return null;
  }
})();

let profileIndex = null;
const profileCache = new Map();

async function getProfile(name) {
  if (!profileCache.has(name)) {
    const res = await fetch(`profiles/${profileIndex[name].file}`);
    if (!res.ok) throw new Error(UNSUPPORTED);
    profileCache.set(name, await loadProfile(new Uint8Array(await res.arrayBuffer())));
  }
  return profileCache.get(name);
}

// Probe with a real decode of a real photo. Checking only that the script loaded
// says nothing about whether it can actually decode, and a decoder that loads but
// cannot decode is the failure mode that is hardest to notice.
let decodeAvailable = null;
async function ensureDecode(bytes) {
  if (decodeAvailable !== null) return decodeAvailable;
  try {
    await loadLibheif();
    await decodeToRgb(bytes, { width: 8, height: 8 });
    decodeAvailable = true;
  } catch (e) {
    console.warn("image analysis unavailable, using neutral settings:", e);
    decodeAvailable = false;
  }
  return decodeAvailable;
}

/** Identify the container from its magic bytes, so a transcoded upload is obvious. */
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b.length > 11 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return /^(hei|mif|msf|avi)/.test(brand) ? "heic" : "iso";
  }
  return "unknown";
}

/** Base64 for the finished photo, in chunks: String.fromCharCode(...bytes) on a
 *  multi-megabyte array overflows the call stack. */
function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < view.length; i += CHUNK)
    parts.push(String.fromCharCode.apply(null, view.subarray(i, i + CHUNK)));
  return btoa(parts.join(""));
}

function row(name) {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = `<div class="name"></div><div class="status"></div><div class="act"></div>`;
  el.querySelector(".name").textContent = name;
  list.appendChild(el);
  return {
    set(text, cls) {
      const s = el.querySelector(".status");
      s.textContent = text;
      s.className = `status ${cls || ""}`;
    },
    link(blob, filename) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.textContent = T("btn.download");
      a.className = el.querySelector(".act").children.length ? "dl alt" : "dl";
      el.querySelector(".act").appendChild(a);
    },
    share(file) {
      const b = document.createElement("button");
      b.className = "dl";
      b.type = "button";
      b.textContent = T("btn.save");
      b.addEventListener("click", async () => {
        try { await navigator.share({ files: [file] }); }
        catch (e) { if (e.name !== "AbortError") b.textContent = T("btn.blocked"); }
      });
      el.querySelector(".act").appendChild(b);
    },
    // Native-only. Hands the finished bytes to PhotoKit as a new asset, with the
    // original filename kept, instead of going through the share sheet.
    saveToLibrary(data, filename) {
      const b = document.createElement("button");
      b.className = "dl";
      b.type = "button";
      b.textContent = T("btn.library");
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = T("btn.saving");
        try {
          await native.save({ data: toBase64(data), name: filename });
          b.textContent = T("btn.saved");
        } catch (e) {
          console.error("could not save to the photo library", filename, e);
          b.disabled = false;
          b.textContent = T("btn.savefailed");
        }
      });
      el.querySelector(".act").appendChild(b);
    },
  };
}

async function handleFile(file) {
  const ui = row(file.name);
  try {
    ui.set(T("st.reading"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniff(bytes) !== "heic") { ui.set(T("err.notheic"), "err"); return; }

    const d = discoverHeic(bytes);
    const sep = lang === "zh" ? "、" : ", ";
    let data, bits, suffix;
    if (d.stylesItem !== null) {
      // A native iPhone 16/17 style photo is never re-ported (that would replace its real
      // style data); it only gets the iOS 27 Texture/Grain set added.
      if (hasTexture(d.infos)) { ui.set(T("err.hastexture"), "err"); return; }
      ui.set(T("st.working"));
      ({ data } = addTexture(bytes));
      bits = [T("st.native"), T("st.texture")];
      suffix = "_TextureGrain.HEIC";
    } else {
      // No encoder in the browser, so a photo without a thumbnail needs the desktop tool.
      if (d.thumbnail === null) { ui.set(T("err.nothumb"), "err"); return; }
      const name = selectProfile(profileIndex, d.primaryTiles.length, d.hdrTiles.length);
      const profile = await getProfile(name);

      const canDecode = quality.checked ? await ensureDecode(bytes) : false;
      ui.set(T("st.working"));
      const opts = canDecode
        ? { decode: decodeToRgb, sceneStats: "target", lightMaps: "target" }
        : { sceneStats: "donor" };
      let report;
      ({ data, report } = await patch(bytes, profile, opts));
      // patch() degrades rather than failing when the decoder misbehaves, so trust
      // what it reports it actually did, not what we asked for.
      if (report.decodeError) console.warn("decoder unavailable:", report.decodeError);

      bits = [T(report.decoded ? "st.matched" : "st.neutral")];
      if (report.mattes.added.some((m) => m.startsWith("depth"))) bits.push(T("st.portrait"));
      else if (report.mattes.transplanted.length) bits.push(T("st.people"));
      if (report.texture !== "off") bits.push(T("st.texture"));
      suffix = "_PhotographicStyle.HEIC";
    }
    ui.set(`${T("st.ready")} — ${bits.join(sep)}`, "ok");

    const outName = file.name.replace(/\.(heic|heif)$/i, "") + suffix;
    // In the app, writing straight back to the photo library is the short route
    // and avoids a share-sheet round trip. The download stays available below.
    if (native) ui.saveToLibrary(data, outName);
    // On iPhone the share sheet lands the file straight in Photos; elsewhere a plain
    // download is the shorter route.
    const shareFile = new File([data], outName, { type: "image/heic" });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) ui.share(shareFile);
    ui.link(new Blob([data], { type: "image/heic" }), outName);
  } catch (e) {
    // Past the format sniff, every remaining rejection means the same thing to a
    // visitor: this is a HEIC, but not one this build can handle. The real reason
    // still goes to the console, because "unsupported" on every photo is exactly
    // how a bug elsewhere would look.
    console.error("could not port", file.name, e);
    ui.set(T("err.unsupported"), "err");
  }
}

async function handleFiles(files) {
  for (const f of files) await handleFile(f);
}

drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  handleFiles([...e.dataTransfer.files]);
});
drop.addEventListener("click", () => openPicker());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
});
fileInput.addEventListener("change", () => handleFiles([...fileInput.files]));

// --- native-only chrome -----------------------------------------------------
// Built here rather than in index.html: that file is shared with the web
// deployment and is checked against the offline asset list.
let notice = null;

if (native) {
  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "dl alt";
  browse.style.marginTop = "1rem";
  browse.dataset.i18n = "btn.browse";
  browse.addEventListener("click", () => fileInput.click());
  drop.insertAdjacentElement("afterend", browse);

  notice = document.createElement("p");
  notice.className = "err";
  notice.dataset.i18n = "err.fullaccess";
  notice.hidden = true;
  browse.insertAdjacentElement("afterend", notice);
}

function showNotice(key) {
  if (!notice) return;
  notice.dataset.i18n = key;
  notice.hidden = false;
  applyLanguage(lang); // fills the newly named key in the current language
}

function hideNotice() {
  if (notice) notice.hidden = true;
}

/** Native path: read the original file bytes through PhotoKit, then hand them to
 *  the same handleFiles() the file input uses. Nothing about the conversion
 *  itself is duplicated here. */
async function openPicker() {
  if (!native) { fileInput.click(); return; }
  hideNotice();
  let result;
  try {
    result = await native.pick();
  } catch (e) {
    if (e && e.code === "need_full_access") { showNotice("err.fullaccess"); return; }
    console.error("photo library pick failed", e);
    showNotice("err.pickfailed");
    return;
  }
  const files = [];
  for (const item of result?.files || []) {
    try {
      const res = await fetch(item.webPath);
      files.push(new File([await res.arrayBuffer()], item.name));
    } catch (e) {
      console.error("could not read the picked photo", item.name, e);
    }
  }
  if (files.length) await handleFiles(files);
}

$("lang").addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh";
  rememberLanguage(lang);
  applyLanguage(lang);
});

// Visit counter behind the README badge. The only request this site makes to a
// third party, and it carries nothing but the fact that the page was opened —
// no photo ever reaches it. Fired once per browser session so a reload is not a
// new visit, and fire-and-forget: a counter that is down is not worth an error.
// If sessionStorage is blocked the visit goes uncounted, which undercounts
// rather than counting every reload of a private-mode window as a new visitor.
function countVisit() {
  try {
    if (sessionStorage.getItem("counted")) return;
    sessionStorage.setItem("counted", "1");
  } catch (e) {
    return;
  }
  fetch("https://abacus.jasoncameron.dev/hit/nathanatgit-shalielie/web").catch(() => {});
}

(async () => {
  applyLanguage(lang);
  $("version").textContent = VERSION;
  countVisit();
  try {
    profileIndex = await (await fetch("profiles/index.json")).json();
  } catch (e) {
    $("boot").textContent = e.message;
    $("boot").className = "err";
  }
})();

// Keep installation and offline support progressive: unsupported browsers use
// the page exactly as before, while HTTPS/localhost deployments gain a PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .catch((e) => console.warn("offline support unavailable:", e));
  });
}
