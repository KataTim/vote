/* ============================================================
   js/admin-users.js
   管理员：用户列表 + 身份验证申请审核。

   安全要点：
   - 页面开头的 Auth.requireAdminOrRedirect() 只是 UI 层拦截；
     真正的数据可见性由 sql/verification.sql 里的
     verification_requests_select_own_or_admin /
     account_security_select_admin_only 等策略决定。
   - 审核动作（通过/驳回/要求补充资料）只通过 review_verification_request()
     这一个 RPC 完成，本文件不会直接 UPDATE profiles 或
     verification_requests 的状态字段。
   ============================================================ */

(function () {
  let currentRequestId = null;
  let requestsCache = [];

  function riskTagHtml(level) {
    const lv = level || "low";
    const labelMap = { low: "低", medium: "中", high: "高" };
    return `<span class="risk-tag risk-tag--${lv}">风险: ${labelMap[lv] || lv}</span>`;
  }

  /* ---------------- 身份验证申请列表 ---------------- */

  async function loadRequests() {
    const msgEl = document.getElementById("requests-msg");
    const tableEl = document.getElementById("requests-table");
    const bodyEl = document.getElementById("requests-body");
    const pendingOnly = document.getElementById("filter-pending-only").checked;

    msgEl.textContent = "正在读取申请列表...";
    msgEl.className = "info-box";
    msgEl.style.display = "";
    tableEl.style.display = "none";

    let query = window.sb
      .from("verification_requests")
      .select(
        "*, profiles!verification_requests_user_id_fkey(username, avatar_url, qq_number, created_at), verification_challenges(challenge_type, status, attempts)"
      )
      .order("created_at", { ascending: false });

    if (pendingOnly) query = query.eq("status", "pending");

    const { data, error } = await query;

    if (error) {
      msgEl.textContent = Utils.friendlyError(error, "admin");
      msgEl.className = "error-box";
      return;
    }

    requestsCache = data || [];

    if (requestsCache.length === 0) {
      msgEl.textContent = pendingOnly ? "目前没有待审核的申请。" : "还没有任何身份验证申请。";
      return;
    }

    msgEl.style.display = "none";
    tableEl.style.display = "";
    bodyEl.innerHTML = "";

    requestsCache.forEach((req) => {
      const profile = req.profiles || {};
      const statusInfo = { pending: "待审核", approved: "已通过", rejected: "已驳回", needs_more_info: "需补充资料" }[req.status] || req.status;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${Utils.escapeHtml(profile.username || "(未知用户)")}</td>
        <td>${riskTagHtml(req.risk_level_snapshot)}</td>
        <td>${Utils.escapeHtml(Utils.formatDateTime(req.created_at))}</td>
        <td>${Utils.escapeHtml(statusInfo)}</td>
        <td><button type="button" data-id="${req.id}" class="btn-view-detail">查看</button></td>
      `;
      tr.querySelector(".btn-view-detail").addEventListener("click", () => showDetail(req.id));
      bodyEl.appendChild(tr);
    });
  }

  async function showDetail(requestId) {
    currentRequestId = requestId;
    const req = requestsCache.find((r) => r.id === requestId);
    if (!req) return;

    const profile = req.profiles || {};
    const challenge = Array.isArray(req.verification_challenges) ? req.verification_challenges[0] : req.verification_challenges;

    document.getElementById("detail-title").textContent = "申请详情 — " + (profile.username || "(未知用户)");
    document.getElementById("review-note-input").value = req.review_note || "";
    document.getElementById("review-error").style.display = "none";
    document.getElementById("review-success").style.display = "none";

    let securityHtml = "正在读取安全信号...";
    const contentEl = document.getElementById("detail-content");
    contentEl.innerHTML = `
      <p><b>头像：</b>${profile.avatar_url ? `<img src="${Utils.escapeHtml(profile.avatar_url)}" class="avatar-preview" alt="avatar">` : "(未上传)"}</p>
      <p><b>QQ 号：</b>${Utils.escapeHtml(profile.qq_number || "-")}</p>
      <p><b>注册时间：</b>${Utils.escapeHtml(Utils.formatDateTime(profile.created_at))}</p>
      <p><b>申请理由：</b>${Utils.escapeHtml(req.reason)}</p>
      <p><b>提交时申请人完成的验证任务：</b>${challenge ? Utils.escapeHtml(challenge.challenge_type) + "（状态：" + Utils.escapeHtml(challenge.status) + "，尝试次数：" + challenge.attempts + "）" : "-"}</p>
      <p><b>提交时的风险等级快照：</b>${riskTagHtml(req.risk_level_snapshot)}</p>
      <p><b>当前风险信号：</b><span id="detail-live-risk">${securityHtml}</span></p>
    `;

    document.getElementById("request-detail").style.display = "";
    document.getElementById("request-detail").scrollIntoView({ behavior: "smooth", block: "start" });

    const { data: sec, error: secError } = await window.sb
      .from("account_security")
      .select("risk_level, risk_signals, last_computed_at")
      .eq("user_id", req.user_id)
      .maybeSingle();

    const liveEl = document.getElementById("detail-live-risk");
    if (!liveEl) return; // 用户可能已经切换到别的申请
    if (secError || !sec) {
      liveEl.textContent = "暂无数据";
    } else {
      liveEl.innerHTML =
        riskTagHtml(sec.risk_level) +
        ` （同 IP 账号数：${sec.risk_signals?.shared_ip_count ?? "-"}，同设备账号数：${sec.risk_signals?.shared_device_count ?? "-"}，账号年龄：${sec.risk_signals?.account_age_hours ?? "-"} 小时，更新于 ${Utils.escapeHtml(Utils.formatDateTime(sec.last_computed_at))}）`;
    }
  }

  async function handleReview(action, actionLabel) {
    if (!currentRequestId) return;
    if (!confirm(`确定要"${actionLabel}"这份身份验证申请吗？`)) return;

    const note = document.getElementById("review-note-input").value.trim();
    const errEl = document.getElementById("review-error");
    const okEl = document.getElementById("review-success");
    errEl.style.display = "none";
    okEl.style.display = "none";

    const { error } = await window.sb.rpc("review_verification_request", {
      p_request_id: currentRequestId,
      p_action: action,
      p_note: note || null,
    });

    if (error) {
      errEl.style.display = "";
      errEl.textContent = Utils.friendlyError(error, "verification");
      return;
    }

    okEl.style.display = "";
    okEl.textContent = "已处理：" + actionLabel;
    await loadRequests();
    await loadUsers();
  }

  /* ---------------- 用户列表 ---------------- */

  async function loadUsers() {
    const msgEl = document.getElementById("users-msg");
    const tableEl = document.getElementById("users-table");
    const bodyEl = document.getElementById("users-body");

    msgEl.textContent = "正在读取用户列表...";
    msgEl.className = "info-box";
    msgEl.style.display = "";
    tableEl.style.display = "none";

    const { data, error } = await window.sb
      .from("profiles")
      .select("id, username, avatar_url, qq_number, created_at, verification_status, account_security(risk_level)")
      .order("created_at", { ascending: false });

    if (error) {
      msgEl.textContent = Utils.friendlyError(error, "admin");
      msgEl.className = "error-box";
      return;
    }

    if (!data || data.length === 0) {
      msgEl.textContent = "还没有任何用户。";
      return;
    }

    msgEl.style.display = "none";
    tableEl.style.display = "";
    bodyEl.innerHTML = "";

    data.forEach((u) => {
      const sec = Array.isArray(u.account_security) ? u.account_security[0] : u.account_security;
      const statusInfo = Utils.verificationStatusInfo(u.verification_status);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.avatar_url ? `<img src="${Utils.escapeHtml(u.avatar_url)}" class="avatar-preview" style="width:32px;height:32px;" alt="avatar">` : "-"}</td>
        <td>${Utils.escapeHtml(u.username || "(未设置)")}</td>
        <td>${Utils.escapeHtml(u.qq_number || "-")}</td>
        <td>${Utils.escapeHtml(Utils.formatDateTime(u.created_at))}</td>
        <td><span class="badge ${statusInfo.cls}">${statusInfo.label}</span></td>
        <td>${sec ? riskTagHtml(sec.risk_level) : "-"}</td>
      `;
      bodyEl.appendChild(tr);
    });
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    Auth.initToolbar("toolbar");

    const ctx = await Auth.requireAdminOrRedirect();
    if (!ctx) return;

    document.getElementById("admin-area").style.display = "";

    document.getElementById("btn-refresh-requests").addEventListener("click", loadRequests);
    document.getElementById("filter-pending-only").addEventListener("change", loadRequests);
    document.getElementById("btn-refresh-users").addEventListener("click", loadUsers);

    document.getElementById("btn-approve").addEventListener("click", () => handleReview("approve", "通过"));
    document.getElementById("btn-reject").addEventListener("click", () => handleReview("reject", "驳回"));
    document.getElementById("btn-need-more").addEventListener("click", () => handleReview("need_more_info", "要求补充资料"));
    document.getElementById("btn-close-detail").addEventListener("click", () => {
      document.getElementById("request-detail").style.display = "none";
      currentRequestId = null;
    });

    await loadRequests();
    await loadUsers();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
