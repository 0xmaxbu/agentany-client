// 授权弹窗（ADR-0038 D5 四选）：加载后经 pending_consent 领取最近一次询问（避开事件竞态），
// 60s 倒计时到点自动拒绝。env 类（autoInstall）只有 允许/拒绝 两选。
/* global window */
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

let payload = null;
let left = 60;
let timer = null;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function closeWin() {
  if (timer) clearInterval(timer);
  getCurrentWindow().close();
}

function decide(action) {
  invoke("host_command", { cmd: JSON.stringify({ t: "decision", reqId: payload.reqId, action }) }).then(closeWin, closeWin);
}

function render() {
  const req = payload.req;
  const body = document.getElementById("c-body");
  if (req.kind === "tool") {
    document.getElementById("c-title").textContent = "会话借用请求";
    body.innerHTML = `
      <p>工作流 <code>${esc(req.workflowId)}</code> 请求借用本机会话：</p>
      <p><b>${esc(req.tool)}</b>${req.host ? ` · <code>${esc(req.host)}</code>` : ""}</p>
      ${req.args && Object.keys(req.args).length ? `<pre class="args">${esc(JSON.stringify(req.args, null, 2).slice(0, 800))}</pre>` : ""}
      <p class="muted">「总是允许」= 同类操作（参数敏感）不再询问；「总是允许该工具」= 本工作流内该工具一律放行。</p>`;
  } else {
    document.getElementById("c-title").textContent = "环境补全请求";
    const rows = (req.items ?? []).map((it) => `<tr><td>${esc(it.name)}</td><td><code>${esc(it.autoInstall ?? "—")}</code></td></tr>`).join("");
    body.innerHTML = `
      <p>工作流 <code>${esc(req.workflowId)}</code> 缺少环境，需在本机执行以下安装：</p>
      <table><thead><tr><th>项</th><th>将执行的命令</th></tr></thead><tbody>${rows}</tbody></table>`;
    document.querySelectorAll("#c-actions button").forEach((b) => {
      if (b.dataset.act !== "deny" && b.dataset.act !== "allow_once") b.remove();
    });
  }
}

invoke("pending_consent").then((s) => {
  if (!s) {
    closeWin();
    return;
  }
  payload = JSON.parse(s);
  render();
  document.querySelectorAll("#c-actions button").forEach((b) => (b.onclick = () => decide(b.dataset.act)));
  timer = setInterval(() => {
    left -= 1;
    document.getElementById("c-count").textContent = left;
    if (left <= 0) decide("deny");
  }, 1000);
}, closeWin);
