// 主窗逻辑（设置/onboarding/授权管理）。协议见 apps/host/src/ipc.ts；经 Tauri 事件 host-event 收、host_command 发。
/* global window */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const $ = (id) => document.getElementById(id);
const POLICIES = ["ask_every", "ask_first", "allow", "deny"];
const POLICY_LABEL = { ask_every: "每次询问", ask_first: "首次询问", allow: "放行", deny: "拒绝" };

let grants = { version: 1 };
let hello = null;

const cmd = (o) => invoke("host_command", { cmd: JSON.stringify(o) });

function setConn(state, note) {
  const el = $("conn");
  const map = { online: ["on", "在线"], connecting: ["warn", "连接中…"], reconnecting: ["warn", "重连中…"], offline: ["off", note || "未连接"] };
  const [cls, text] = map[state] ?? map.offline;
  el.className = `badge ${cls}`;
  el.textContent = text;
}

function showLogin(note) {
  $("sec-login").hidden = false;
  $("sec-manage").hidden = true;
  if (note) $("login-err").textContent = note;
}

function hideLogin() {
  $("sec-login").hidden = true;
  $("sec-manage").hidden = false;
}

function renderGrants() {
  const fill = (sel, val) => {
    sel.innerHTML = "";
    for (const p of POLICIES) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = POLICY_LABEL[p];
      sel.append(o);
    }
    sel.value = val;
  };
  fill($("g-borrow"), grants.defaults?.borrow ?? "ask_first");
  fill($("g-rest"), grants.defaults?.rest ?? "allow");
  fill($("r-policy"), "deny");

  const ul = $("g-remembered");
  ul.innerHTML = "";
  for (const g of grants.remembered ?? []) {
    const li = document.createElement("li");
    let text;
    if ("face" in g) text = g.face === "browser" ? `浏览器 · ${g.host}` : "桌面控制（computer_use）";
    else if ("anyArgs" in g) text = `工具 ${g.tool}（任意参数）`;
    else text = `工具 ${g.tool}`;
    const scope = document.createElement("span");
    scope.innerHTML = `<code>${g.workflowId || "?"}</code> ${text}`;
    const btn = document.createElement("button");
    btn.textContent = "撤除";
    btn.className = "danger";
    btn.onclick = () => {
      grants.remembered = (grants.remembered ?? []).filter((x) => x !== g);
      renderGrants();
    };
    li.append(scope, btn);
    ul.append(li);
  }
  if (!(grants.remembered ?? []).length) ul.innerHTML = '<li class="muted">（无——弹窗选「总是允许」后产生）</li>';

  const tb = $("g-rules").querySelector("tbody");
  tb.innerHTML = "";
  (grants.rules ?? []).forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><code>${r.workflowId ?? "全部"}</code></td><td>${r.tool ?? "全部"}</td><td>${r.host ?? "—"}</td><td>${POLICY_LABEL[r.policy] ?? r.policy}</td>`;
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "删除";
    btn.className = "danger";
    btn.onclick = () => {
      grants.rules = (grants.rules ?? []).filter((_, j) => j !== i);
      renderGrants();
    };
    td.append(btn);
    tr.append(td);
    tb.append(tr);
  });
}

// —— 事件面（host stdout 逐行）——
listen("host-event", (e) => {
  let m;
  try {
    m = JSON.parse(e.payload);
  } catch {
    return;
  }
  switch (m.t) {
    case "hello":
      hello = m;
      $("dev-id").textContent = `设备 ${m.deviceId.slice(0, 8)}…`;
      if (m.configured) hideLogin();
      else showLogin();
      break;
    case "status":
      setConn(m.s);
      if (m.s === "online") hideLogin();
      break;
    case "stop":
      setConn("offline", { kicked: "已被其他设备顶下线", logout: "已登出", replaced: "本机其他实例接管", auth_failed: "登录已失效", stopped: "已停止" }[m.reason] ?? "未连接");
      if (m.reason === "auth_failed") showLogin("登录已失效，请重新登录"); // kicked/replaced 只展示不弹表单（P5a 语义）
      break;
    case "login-result":
      if (!m.ok) $("login-err").textContent = m.error;
      break;
    case "logged-out":
      showLogin();
      setConn("offline", "已登出");
      break;
    case "grants":
      grants = m.grants;
      renderGrants();
      break;
    case "grants-saved":
      $("grants-msg").textContent = "已保存";
      cmd({ t: "grants-get" });
      break;
  }
});

// —— 命令面 ——
$("btn-login").onclick = () => {
  $("login-err").textContent = "";
  cmd({ t: "login", serverUrl: $("f-url").value.trim(), username: $("f-user").value.trim(), password: $("f-pass").value });
};
$("btn-logout").onclick = () => cmd({ t: "logout" });
$("btn-add-rule").onclick = () => {
  const rule = { policy: $("r-policy").value };
  for (const [k, id] of [["workflowId", "r-wf"], ["tool", "r-tool"], ["host", "r-host"]]) {
    const v = $(id).value.trim();
    if (v) rule[k] = v;
  }
  grants.rules = [...(grants.rules ?? []), rule];
  renderGrants();
};
$("btn-save-grants").onclick = () => {
  grants.defaults = { borrow: $("g-borrow").value, rest: $("g-rest").value };
  $("grants-msg").textContent = "保存中…";
  cmd({ t: "grants-put", grants });
};

// —— 开机自启（autostart 插件命令）——
const AUTO = "plugin:autostart";
invoke(`${AUTO}|is_enabled`)
  .then((on) => ($("autostart").checked = Boolean(on)))
  .catch(() => {});
$("autostart").onchange = (e) => {
  invoke(`${AUTO}|${e.target.checked ? "enable" : "disable"}`).catch((err) => {
    $("grants-msg").textContent = `自启设置失败：${err}`;
    e.target.checked = !e.target.checked;
  });
};

// —— 关窗不退出（驻留托盘）——
getCurrentWindow().onCloseRequested(async (e) => {
  e.preventDefault();
  await getCurrentWindow().hide();
});

// 启动即取当前授权档
cmd({ t: "grants-get" });
