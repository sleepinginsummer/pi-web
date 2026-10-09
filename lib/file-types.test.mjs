import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-types.ts");
}

test("detects image, audio, and document preview paths", async () => {
  const {
    getAudioMime,
    getDocumentMime,
    getImageMime,
    isAudioPath,
    isDocumentPreviewPath,
    isImagePath,
  } = await loadSubject();

  assert.equal(getImageMime("/tmp/screenshot.PNG"), "image/png");
  assert.equal(getAudioMime("C:\\Users\\me\\voice.OPUS"), "audio/ogg");
  assert.equal(getDocumentMime("/tmp/report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(isImagePath("/tmp/screenshot.PNG"), true);
  assert.equal(isAudioPath("C:\\Users\\me\\voice.OPUS"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.pdf"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.txt"), false);
});

test("detects video preview paths and treats webm as video", async () => {
  const { getAudioMime, getVideoMime, isVideoPath } = await loadSubject();

  assert.equal(getVideoMime("/tmp/clip.MP4"), "video/mp4");
  assert.equal(getVideoMime("C:\\Users\\me\\recording.webm"), "video/webm");
  assert.equal(getVideoMime("/tmp/movie.mov"), "video/quicktime");
  assert.equal(getVideoMime("/tmp/notes.txt"), null);
  assert.equal(isVideoPath("/tmp/clip.mp4"), true);
  assert.equal(isVideoPath("/tmp/song.mp3"), false);
  assert.equal(getAudioMime("/tmp/recording.webm"), null);
  assert.equal(getAudioMime("/tmp/voice.weba"), "audio/webm");
});

test("serves inline files with their own content type", async () => {
  const { getInlineFileMime } = await loadSubject();

  assert.equal(getInlineFileMime("/tmp/report.HTML"), "text/html; charset=utf-8");
  assert.equal(getInlineFileMime("/tmp/site/style.css"), "text/css; charset=utf-8");
  assert.equal(getInlineFileMime("/tmp/site/app.mjs"), "text/javascript; charset=utf-8");
  assert.equal(getInlineFileMime("/tmp/site/data.json"), "application/json; charset=utf-8");
  // Image, audio, video, and document kinds keep their existing types.
  assert.equal(getInlineFileMime("/tmp/chart.svg"), "image/svg+xml");
  assert.equal(getInlineFileMime("/tmp/photo.png"), "image/png");
  assert.equal(getInlineFileMime("/tmp/report.pdf"), "application/pdf");
  // An unknown extension still needs a type rather than a null.
  assert.equal(getInlineFileMime("/tmp/archive.tar.zst"), "application/octet-stream");
});

test("extracts extensions from mixed path styles", async () => {
  const { documentPreviewKind, getFileExt } = await loadSubject();

  assert.equal(getFileExt("/tmp/archive.tar.gz"), "gz");
  assert.equal(getFileExt("C:\\Users\\me\\photo.AVIF"), "avif");
  assert.equal(documentPreviewKind("/tmp/manual.PDF"), "pdf");
  assert.equal(documentPreviewKind("/tmp/manual.md"), null);
});
