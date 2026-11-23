// ==UserScript==
// @name         视频地址检测
// @match        *://*/*
// @run-at       document-idle
// ==/UserScript==

(function () {
  const btn = document.createElement("button");
  btn.textContent = "检测视频地址";
  Object.assign(btn.style, {
    position: "fixed",
    right: "15px",
    bottom: "100px",
    zIndex: "2147483647",
    padding: "14px",
    background: "#087cff",
    color: "white",
    border: "0",
    borderRadius: "12px",
    fontSize: "16px"
  });

  btn.onclick = () => {
    const videos = [...document.querySelectorAll("video")];
    const result = videos.map((v, i) => ({
      视频: i + 1,
      地址: v.currentSrc || v.src || "未发现",
      时长: v.duration,
      类型: v.querySelector("source")?.type || "未知"
    }));

    prompt(
      "检测结果（复制内容发给我）",
      JSON.stringify(result, null, 2)
    );
  };

  document.body.appendChild(btn);
})();
