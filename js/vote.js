/* ============================================================
   js/vote.js
   投票详情页逻辑。

   - 从 URL 中读取 public_id (?id=xxx，由 404.html 从
     /vote/xxx 这样的路径转换而来)
   - 查询 polls + poll_options + poll_settings
   - 必须登录才能投票；未登录/已投票/未开始/已结束/已关闭/
     未发布 都会分别给出对应的提示并禁止提交
   - 提交投票依赖数据库 UNIQUE(poll_id, user_id) 与相关 RLS
     策略作为最终防线，前端只是提前给出友好提示
   - 结果通过 RPC 函数 get_poll_results() 获取聚合票数
     (需要额外 SQL，见项目 README 中的"补充 SQL"部分)
   ============================================================ */

(function () {
  let currentPoll = null;
  let currentSettings = null;
  let currentUser = null;

  function getPublicIdFromUrl() {
    const fromQuery = Utils.qs("id");
    if (fromQuery) return fromQuery;

    // 兜底：如果有人直接访问 vote.html/2937739 这种形式
    const match = window.location.pathname.match(/vote(?:\.html)?\/(\d+)/);
    return match ? match[1] : null;
  }

  function showMsg(text, boxClass) {
    const el = document.getElementById("poll-msg");
    el.textContent = text;
    el.className = boxClass || "info-box";
    el.style.display = "";
    document.getElementById("poll-content").style.display = "none";
  }

  function setNotice(id, text) {
    const el = document.getElementById(id);
    if (!text) {
      el.style.display = "none";
      return;
    }
    el.textContent = text;
    el.style.display = "";
  }

  async function loadPoll(publicId) {
    const { data, error } = await window.sb
      .from("polls")
      .select("*, poll_options(*), poll_settings(*)")
      .eq("public_id", publicId)
      .maybeSingle();

    if (error) {
      showMsg(Utils.friendlyError(error, "vote"), "error-box");
      return null;
    }
    if (!data) {
      showMsg("投票不存在，或尚未发布。", "error-box");
      return null;
    }
    return data;
  }

  function normalizeSettings(poll) {
    let s = poll.poll_settings;
    if (Array.isArray(s)) s = s[0];
    return {
      allow_multiple_choices: !!(s && s.allow_multiple_choices),
      show_results_before_end: !!(s && s.show_results_before_end),
      randomize_options: !!(s && s.randomize_options),
      allow_unverified_users: !!(s && s.allow_unverified_users),
    };
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function renderHeader(poll) {
    document.getElementById("poll-title").textContent = poll.title;
    document.getElementById("poll-desc").textContent = poll.description || "";
    document.getElementById("poll-start").textContent = Utils.formatDateTime(poll.start_time);
    document.getElementById("poll-end").textContent = Utils.formatDateTime(poll.end_time);

    const status = Utils.getPollStatus(poll);
    const badge = document.getElementById("poll-status-badge");
    badge.textContent = status.label;
    badge.className = "badge " + status.badgeClass;
    return status;
  }

  function renderOptionsForm(options, allowMultiple) {
    const container = document.getElementById("options-container");
    container.innerHTML = "";
    const inputType = allowMultiple ? "checkbox" : "radio";

    options.forEach((opt) => {
      const row = document.createElement("div");
      row.className = "option-row";
      row.innerHTML = `
        <input type="${inputType}" name="poll-option" id="opt-${opt.id}" value="${opt.id}" />
        <label for="opt-${opt.id}">${Utils.escapeHtml(opt.option_text)}</label>
      `;
      container.appendChild(row);
    });

    if (allowMultiple) {
      const hint = document.createElement("p");
      hint.className = "form-hint";
      hint.textContent = "本投票允许多选。";
      container.appendChild(hint);
    }
  }

  async function fetchMyVotes(pollId, userId) {
    const { data, error } = await window.sb
      .from("votes")
      .select("id, option_id")
      .eq("poll_id", pollId)
      .eq("user_id", userId);
    if (error) {
      console.warn("[vote.js] 读取投票记录失败：", error.message);
      return [];
    }
    return data || [];
  }

  async function loadResults(publicId) {
    const { data, error } = await window.sb.rpc("get_poll_results", { p_public_id: publicId });
    const section = document.getElementById("results-section");
    const container = document.getElementById("results-container");

    if (error) {
      section.style.display = "";
      container.innerHTML = `<div class="error-box">结果暂时无法显示：${Utils.escapeHtml(error.message)}<br>
        （如果这是新部署的项目，请确认已在 Supabase 中创建 get_poll_results() 函数，见部署说明。）</div>`;
      return;
    }
    if (!data || data.length === 0) {
      section.style.display = "";
      container.innerHTML = `<p style="font-size:12px;">暂无投票数据。</p>`;
      return;
    }

    const total = data.reduce((sum, row) => sum + Number(row.vote_count), 0) || 1;
    section.style.display = "";
    container.innerHTML = data
      .sort((a, b) => a.option_order - b.option_order)
      .map((row) => {
        const pct = Math.round((Number(row.vote_count) / total) * 100);
        return `
          <div class="mt8">
            <div class="result-line">
              <span>${Utils.escapeHtml(row.option_text)}</span>
              <span>${row.vote_count} 票 (${pct}%)</span>
            </div>
            <div class="result-bar-outer"><div class="result-bar-inner" style="width:${pct}%;"></div></div>
          </div>
        `;
      })
      .join("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setNotice("vote-error", null);

    if (!currentUser) {
      setNotice("vote-error", "请先登录后参与投票。");
      return;
    }

    const { data: latestProfile, error: profileError } = await window.sb
      .from("profiles")
      .select("verification_status")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (profileError) {
      setNotice("vote-error", "暂时无法确认您的身份验证状态，请刷新页面后重试。");
      return;
    }

    const latestVerificationStatus =
      (latestProfile && latestProfile.verification_status) || "unverified";

    if (!currentSettings.allow_unverified_users &&
        latestVerificationStatus !== "verified") {
      setNotice("vote-error", "本投票仅允许已验证用户参与。");
      return;
    }
    setNotice("vote-success", null);

    const checked = Array.from(document.querySelectorAll('input[name="poll-option"]:checked'));
    if (checked.length === 0) {
      setNotice("vote-error", "请至少选择一个选项。");
      return;
    }

    const submitBtn = document.getElementById("vote-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "提交中...";

    const rows = checked.map((input) => ({
      poll_id: currentPoll.id,
      option_id: input.value,
      user_id: currentUser.id,
    }));

    const { error } = await window.sb.from("votes").insert(rows);

    submitBtn.disabled = false;
    submitBtn.textContent = "提交投票";

    if (error) {
      setNotice("vote-error", Utils.friendlyError(error, "vote"));
      return;
    }

    setNotice("vote-success", "投票成功，感谢您的参与！");
    document.getElementById("vote-form").style.display = "none";
    await loadResultsIfAllowed();
  }

  async function loadResultsIfAllowed() {
    const status = Utils.getPollStatus(currentPoll);
    const canSeeResults =
      currentSettings.show_results_before_end ||
      status.code === "ended" ||
      status.code === "closed";
    if (canSeeResults) {
      await loadResults(currentPoll.public_id);
    } else {
      setNotice("vote-notice", (document.getElementById("vote-notice").textContent || "") ||
        "投票尚未结束，结果将在结束后公布。");
      document.getElementById("results-section").style.display = "none";
    }
  }

  async function init() {
    Auth.initToolbar("toolbar");

    const publicId = getPublicIdFromUrl();
    if (!publicId) {
      showMsg("无效的投票链接。", "error-box");
      return;
    }

    const poll = await loadPoll(publicId);
    if (!poll) return;

    currentPoll = poll;
    currentSettings = normalizeSettings(poll);

    document.getElementById("poll-msg").style.display = "none";
    document.getElementById("poll-content").style.display = "";

    const status = renderHeader(poll);

    let options = (poll.poll_options || []).slice().sort((a, b) => a.option_order - b.option_order);
    if (currentSettings.randomize_options) options = shuffle(options);

    const { user, profile } = await Auth.getCurrentUserAndProfile();
    currentUser = user;

    if (!user) {
      setNotice("vote-notice", "请先登录后参与投票。");
      const loginLink = document.createElement("p");
      const target = "vote.html?id=" + encodeURIComponent(publicId);
      loginLink.innerHTML = `<a class="button-link" href="login.html?redirect=${encodeURIComponent(target)}"><button>前往登录</button></a>`;
      document.getElementById("vote-notice").insertAdjacentElement("afterend", loginLink);
      await loadResultsIfAllowedForGuest(status);
      return;
    }

    const verificationStatus = (profile && profile.verification_status) || "unverified";

    if (!currentSettings.allow_unverified_users && verificationStatus !== "verified") {
      const statusMessages = {
        unverified: "您尚未完成身份验证，本投票仅允许已验证用户参与。",
        pending: "您的身份验证正在审核中，本投票仅允许已验证用户参与。",
        rejected: "您的身份验证未通过，本投票仅允许已验证用户参与。",
        needs_more_info: "您的身份验证需要补充资料，本投票仅允许已验证用户参与。",
      };

      setNotice(
        "vote-notice",
        statusMessages[verificationStatus] || "您当前未通过身份验证，本投票仅允许已验证用户参与。"
      );

      await loadResultsIfAllowed();
      return;
    }

    const myVotes = await fetchMyVotes(poll.id, user.id);

    if (myVotes.length > 0) {
      setNotice("vote-success", "您已经参与过本次投票，感谢您的参与！");
      await loadResultsIfAllowed();
      return;
    }

    if (!status.canVote) {
      let reason = "当前无法投票。";
      if (status.code === "upcoming") reason = "投票尚未开始，请开始后再来参与。";
      if (status.code === "ended") reason = "投票已经结束。";
      if (status.code === "closed") reason = "投票已被管理员关闭。";
      if (status.code === "draft") reason = "该投票尚未发布。";
      setNotice("vote-notice", reason);
      await loadResultsIfAllowed();
      return;
    }

    // 可以投票
    if (currentSettings.allow_unverified_users) {
      setNotice("vote-notice", "本投票允许尚未完成身份验证的登录用户参与。");
    }
    renderOptionsForm(options, currentSettings.allow_multiple_choices);
    document.getElementById("vote-form").style.display = "";
    document.getElementById("vote-form").addEventListener("submit", handleSubmit);

    if (currentSettings.show_results_before_end) {
      await loadResults(poll.public_id);
    }
  }

  async function loadResultsIfAllowedForGuest(status) {
    const canSeeResults =
      currentSettings.show_results_before_end ||
      status.code === "ended" ||
      status.code === "closed";
    if (canSeeResults) {
      await loadResults(currentPoll.public_id);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
