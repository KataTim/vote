/* ============================================================
   js/index.js
   首页逻辑：渲染顶部工具条 + 加载已发布的公开投票列表。
   ============================================================ */

(function () {
  async function loadPolls() {
    const msgEl = document.getElementById("poll-list-msg");
    const tableEl = document.getElementById("poll-list-table");
    const bodyEl = document.getElementById("poll-list-body");

    const { data, error } = await window.sb
      .from("polls")
      .select("id, public_id, title, description, start_time, end_time, is_published, is_closed, created_at")
      .eq("is_published", true)
      .order("created_at", { ascending: false });

    if (error) {
      msgEl.textContent = Utils.friendlyError(error, "index");
      msgEl.className = "error-box";
      return;
    }

    if (!data || data.length === 0) {
      msgEl.textContent = "目前还没有公开的投票，请稍后再来看看吧。";
      msgEl.className = "info-box";
      return;
    }

    msgEl.style.display = "none";
    tableEl.style.display = "";
    bodyEl.innerHTML = "";

    data.forEach((poll) => {
      const status = Utils.getPollStatus(poll);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div class="poll-title">${Utils.escapeHtml(poll.title)}</div>
          <div class="poll-desc">${Utils.escapeHtml(poll.description || "")}</div>
        </td>
        <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        <td>${Utils.escapeHtml(Utils.formatDateTime(poll.start_time))}</td>
        <td>${Utils.escapeHtml(Utils.formatDateTime(poll.end_time))}</td>
        <td><a class="button-link" href="vote.html?id=${encodeURIComponent(poll.public_id)}"><button>进入投票 →</button></a></td>
      `;
      bodyEl.appendChild(tr);
    });

    const counter = document.getElementById("hit-counter");
    if (counter) {
      counter.textContent = String(data.length).padStart(6, "0");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    Auth.initToolbar("toolbar");
    loadPolls();
  });
})();
