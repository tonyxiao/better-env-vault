const { ipcRenderer } = require("electron");

let source = "Source";
function install() {
  if (document.querySelector("#bev-source-switcher")) return;
  const style = document.createElement("style");
  style.textContent = `
    #bev-source-switcher {
      position: fixed; z-index: 2147483647; top: 10px; right: 14px;
      max-width: min(260px, 42vw); height: 30px; padding: 0 11px;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 999px; background: color-mix(in srgb, Canvas 92%, transparent);
      color: CanvasText; font: 500 12px system-ui; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; backdrop-filter: blur(16px);
      box-shadow: 0 1px 5px color-mix(in srgb, CanvasText 10%, transparent);
    }
    #bev-source-switcher:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
  `;
  const button = document.createElement("button");
  button.id = "bev-source-switcher";
  button.type = "button";
  button.textContent = source;
  button.setAttribute("aria-label", "Switch 1Password source");
  button.addEventListener("click", () => ipcRenderer.send("shell:source-menu"));
  document.documentElement.append(style, button);
}

ipcRenderer.on("shell:source", (_event, label) => {
  source = typeof label === "string" ? label : "Source";
  const button = document.querySelector("#bev-source-switcher");
  if (button) button.textContent = source;
});
window.addEventListener("DOMContentLoaded", install, { once: true });
