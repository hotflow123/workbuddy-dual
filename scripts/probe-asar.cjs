const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { app } = require("electron");

const asar = "F://WorkBuddy-AI//resources//app.asar";

async function main() {
  const out = {};
  try {
    const h = await fsp.open(asar, "r");
    const buf = Buffer.alloc(16);
    const r = await h.read(buf, 0, 16, 0);
    out.filehandle = { bytesRead: r.bytesRead, jsonLen: buf.readUInt32LE(12) };
    await h.close();
  } catch (e) { out.filehandle = "ERR " + e.message; }

  try {
    const fd = fs.openSync(asar, "r");
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    out.readSync = { bytesRead: n, jsonLen: buf.readUInt32LE(12) };
    fs.closeSync(fd);
  } catch (e) { out.readSync = "ERR " + e.message; }

  try {
    const text = await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(asar, { start: 0, end: 15 });
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    out.stream = { length: text.length, jsonLen: text.readUInt32LE(12) };
  } catch (e) { out.stream = "ERR " + e.message; }

  console.log("PROBE " + JSON.stringify(out));
  app.exit(0);
}

app.whenReady().then(main);
