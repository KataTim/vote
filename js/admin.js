/* ============================================================
   js/admin.js
   管理后台逻辑。

   重要安全说明（再次强调）：
   本页面开头的 Auth.requireAdminOrRedirect() 只是为了不让
   普通用户"看到"管理界面，属于 UI 层面的判断。
   真正阻止非管理员读写 polls / poll_options / poll_settings /
   votes 的，必须是 Supabase 数据库的 RLS 策略（基于
   profiles.is_admin 的 EXISTS 子查询）。前端拿不到、也不需要
   拿到 service_role key。
   ============================================================ */

(function () {
  let editingPollId = null;
  let optionRowSeq = 0;


  /* ---------------- 投票访问设置（固定于 admin.html 中的 #poll-publish-settings） ---------------- */

  function setPublishSettingsMode(isCreate) {
    const autoWrap = document.getElementById("f-auto-publish-wrap");
    const auto = document.getElementById("f-auto-publish");
    if (autoWrap) autoWrap.style.display = isCreate ? "" : "none";
    if (!isCreate && auto) auto.checked = false;
  }

  /* ---------------- 选项编辑器 ---------------- */

  function addOptionRow(text, existingId) {
    const container = document.getElementById("options-editor");
    const rowId = "opt-row-" + (optionRowSeq++);
    const row = document.createElement("div");
    row.className = "option-editor-row";
    row.dataset.existingId = existingId || "";
    row.id = rowId;
    row.innerHTML = `
      <input type="text" value="${Utils.escapeHtml(text || "")}" maxlength="200" placeholder="选项内容" />
      <button type="button" class="btn-remove-option">删除</button>
    `;
    row.querySelector(".btn-remove-option").addEventListener("click", () => row.remove());
    container.appendChild(row);
  }

  function clearOptionRows() {
    document.getElementById("options-editor").innerHTML = "";
  }

  function collectOptions() {
    const rows = Array.from(document.querySelectorAll("#options-editor .option-editor-row"));
    return rows
      .map((row, idx) => ({
        existingId: row.dataset.existingId || null,
        option_text: row.querySelector("input[type='text']").value.trim(),
        option_order: idx,
      }))
      .filter((o) => o.option_text.length > 0);
  }

  /* ---------------- 表单模式切换 ---------------- */

  function resetFormToCreateMode() {
    editingPollId = null;
    document.getElementById("editing-poll-id").value = "";
    document.getElementById("form-title-bar").textContent = "➕ 创建新投票";
    document.getElementById("poll-form-submit").textContent = "创建投票";
    document.getElementById("btn-cancel-edit").style.display = "none";
    document.getElementById("poll-form").reset();
    setPublishSettingsMode(true);
    clearOptionRows();
    addOptionRow("");
    addOptionRow("");
    setFormMsg(null, null);
  }

  function loadPollIntoForm(poll) {
    editingPollId = poll.id;
    document.getElementById("editing-poll-id").value = poll.id;
    document.getElementById("form-title-bar").textContent = "✏️ 编辑投票：" + poll.title;
    document.getElementById("poll-form-submit").textContent = "保存修改";
    document.getElementById("btn-cancel-edit").style.display = "";
    setPublishSettingsMode(false);

    document.getElementById("f-title").value = poll.title || "";
    document.getElementById("f-desc").value = poll.description || "";
    document.getElementById("f-start").value = Utils.toDateTimeLocalValue(poll.start_time);
    document.getElementById("f-end").value = Utils.toDateTimeLocalValue(poll.end_time);

    const settings = Array.isArray(poll.poll_settings) ? poll.poll_settings[0] : poll.poll_settings;
    document.getElementById("f-allow-multi").checked = !!(settings && settings.allow_multiple_choices);
    document.getElementById("f-show-results").checked = !!(settings && settings.show_results_before_end);
    document.getElementById("f-randomize").checked = !!(settings && settings.randomize_options);
    const allowUnverified = document.getElementById("f-allow-unverified");
    if (allowUnverified) allowUnverified.checked = !!(settings && settings.allow_unverified_users);

    clearOptionRows();
    const opts = (poll.poll_options || []).slice().sort((a, b) => a.option_order - b.option_order);
    if (opts.length === 0) {
      addOptionRow("");
      addOptionRow("");
    } else {
      opts.forEach((o) => addOptionRow(o.option_text, o.id));
    }

    setFormMsg(null, null);
    document.getElementById("poll-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setFormMsg(errorText, successText) {
    const errEl = document.getElementById("form-error");
    const okEl = document.getElementById("form-success");
    if (errorText) {
      errEl.textContent = errorText;
      errEl.style.display = "";
    } else {
      errEl.style.display = "none";
    }
    if (successText) {
      okEl.textContent = successText;
      okEl.style.display = "";
    } else {
      okEl.style.display = "none";
    }
  }

  /* ---------------- 生成唯一 public_id ---------------- */

  function randomPublicId() {
    // 7 位随机数字，例如 2937739
    return String(Math.floor(1000000 + Math.random() * 9000000));
  }

  async function insertPollWithUniquePublicId(basePayload, maxAttempts) {
    let lastError = null;
    for (let i = 0; i < (maxAttempts || 6); i++) {
      const publicId = randomPublicId();
      const { data, error } = await window.sb
        .from("polls")
        .insert({ ...basePayload, public_id: publicId })
        .select()
        .single();

      if (!error) return { data, error: null };

      lastError = error;
      // 23505 = unique_violation，说明 public_id 撞号了，换一个再试
      if (error.code !== "23505") {
        return { data: null, error };
      }
    }
    return { data: null, error: lastError };
  }

  /* ---------------- 保存 (创建/更新) ---------------- */

  async function handleFormSubmit(e) {
    e.preventDefault();
    setFormMsg(null, null);

    const title = document.getElementById("f-title").value.trim();
    const description = document.getElementById("f-desc").value.trim();
    const startLocal = document.getElementById("f-start").value;
    const endLocal = document.getElementById("f-end").value;
    const allowMulti = document.getElementById("f-allow-multi").checked;
    const showResults = document.getElementById("f-show-results").checked;
    const randomize = document.getElementById("f-randomize").checked;
    const allowUnverified = !!document.getElementById("f-allow-unverified")?.checked;
    const autoPublish = !!document.getElementById("f-auto-publish")?.checked;
    const options = collectOptions();

    if (!title) {
      setFormMsg("请填写投票标题。");
      return;
    }
    if (!startLocal || !endLocal) {
      setFormMsg("请填写开始和结束时间。");
      return;
    }
    const startISO = new Date(startLocal).toISOString();
    const endISO = new Date(endLocal).toISOString();
    if (new Date(endISO) <= new Date(startISO)) {
      setFormMsg("结束时间必须晚于开始时间。");
      return;
    }
    if (options.length < 2) {
      setFormMsg("至少需要 2 个有效选项。");
      return;
    }

    const submitBtn = document.getElementById("poll-form-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "保存中...";

    const { user } = await Auth.getCurrentUserAndProfile();

    try {
      if (!editingPollId) {
        await createPoll({ title, description, startISO, endISO, allowMulti, showResults, randomize, allowUnverified, autoPublish, options, userId: user.id });
      } else {
        await updatePoll({ pollId: editingPollId, title, description, startISO, endISO, allowMulti, showResults, randomize, allowUnverified, options });
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = editingPollId ? "保存修改" : "创建投票";
    }
  }

  async function createPoll(p) {
    const { data: poll, error: pollError } = await insertPollWithUniquePublicId({
      title: p.title,
      description: p.description,
      start_time: p.startISO,
      end_time: p.endISO,
      is_published: !!p.autoPublish,
      is_closed: false,
      created_by: p.userId,
    });

    if (pollError) {
      setFormMsg(Utils.friendlyError(pollError, "admin"));
      return;
    }

    const { error: settingsError } = await window.sb.from("poll_settings").insert({
      poll_id: poll.id,
      allow_multiple_choices: p.allowMulti,
      show_results_before_end: p.showResults,
      randomize_options: p.randomize,
      allow_unverified_users: !!p.allowUnverified,
    });

    if (settingsError) {
      setFormMsg(
        "投票已创建（编号 " + poll.public_id + "），但保存选项设置时出错：" +
        Utils.friendlyError(settingsError, "admin") +
        "，请稍后通过编辑功能重新保存一次。"
      );
    }

    const optionRows = p.options.map((o) => ({
      poll_id: poll.id,
      option_text: o.option_text,
      option_order: o.option_order,
    }));
    const { error: optionsError } = await window.sb.from("poll_options").insert(optionRows);

    if (optionsError) {
      setFormMsg(
        "投票已创建（编号 " + poll.public_id + "），但保存选项时出错：" +
        Utils.friendlyError(optionsError, "admin") +
        "，请通过编辑功能补充选项。"
      );
      await refreshList();
      return;
    }

    setFormMsg(null, "投票创建成功！编号：" + poll.public_id + (poll.is_published ? "（已立即发布）" : "（当前为未发布状态，请在下方列表点击「发布」）"));
    resetFormToCreateMode();
    await refreshList();
  }

  async function updatePoll(p) {
    const { error: pollError } = await window.sb
      .from("polls")
      .update({
        title: p.title,
        description: p.description,
        start_time: p.startISO,
        end_time: p.endISO,
      })
      .eq("id", p.pollId);

    if (pollError) {
      setFormMsg(Utils.friendlyError(pollError, "admin"));
      return;
    }

    // upsert poll_settings
    const { error: settingsError } = await window.sb
      .from("poll_settings")
      .upsert(
        {
          poll_id: p.pollId,
          allow_multiple_choices: p.allowMulti,
          show_results_before_end: p.showResults,
          randomize_options: p.randomize,
          allow_unverified_users: !!p.allowUnverified,
        },
        { onConflict: "poll_id" }
      );

    if (settingsError) {
      setFormMsg("投票基本信息已更新，但保存选项设置时出错：" + Utils.friendlyError(settingsError, "admin"));
    }

    // 同步选项：更新已有的，插入新增的，删除被移除的
    const { data: existingOptions, error: fetchOptError } = await window.sb
      .from("poll_options")
      .select("id")
      .eq("poll_id", p.pollId);

    if (fetchOptError) {
      setFormMsg("保存选项时出错：" + Utils.friendlyError(fetchOptError, "admin"));
      await refreshList();
      return;
    }

    const existingIds = new Set((existingOptions || []).map((o) => o.id));
    const submittedIds = new Set(p.options.filter((o) => o.existingId).map((o) => o.existingId));

    const toUpdate = p.options.filter((o) => o.existingId);
    const toInsert = p.options.filter((o) => !o.existingId);
    const toDeleteIds = Array.from(existingIds).filter((id) => !submittedIds.has(id));

    for (const o of toUpdate) {
      const { error } = await window.sb
        .from("poll_options")
        .update({ option_text: o.option_text, option_order: o.option_order })
        .eq("id", o.existingId);
      if (error) {
        setFormMsg("更新选项时出错：" + Utils.friendlyError(error, "admin"));
        await refreshList();
        return;
      }
    }

    if (toInsert.length > 0) {
      const { error } = await window.sb.from("poll_options").insert(
        toInsert.map((o) => ({ poll_id: p.pollId, option_text: o.option_text, option_order: o.option_order }))
      );
      if (error) {
        setFormMsg("新增选项时出错：" + Utils.friendlyError(error, "admin"));
        await refreshList();
        return;
      }
    }

    if (toDeleteIds.length > 0) {
      const { error } = await window.sb.from("poll_options").delete().in("id", toDeleteIds);
      if (error) {
        setFormMsg(
          "部分选项已保存，但删除旧选项时出错：" + Utils.friendlyError(error, "admin") +
          "（如果该选项已有投票记录，可能需要先在数据库中处理相关 votes 记录）。"
        );
        await refreshList();
        return;
      }
    }

    setFormMsg(null, "投票已更新。");
    resetFormToCreateMode();
    await refreshList();
  }

  /* ---------------- 列表 ---------------- */

  async function refreshList() {
    const msgEl = document.getElementById("admin-list-msg");
    const tableEl = document.getElementById("admin-poll-table");
    const bodyEl = document.getElementById("admin-poll-body");

    msgEl.textContent = "正在读取投票列表...";
    msgEl.className = "info-box";
    msgEl.style.display = "";
    tableEl.style.display = "none";

    const { data, error } = await window.sb
      .from("polls")
      .select("*, poll_options(*), poll_settings(*)")
      .order("created_at", { ascending: false });

    if (error) {
      msgEl.textContent = Utils.friendlyError(error, "admin");
      msgEl.className = "error-box";
      return;
    }

    if (!data || data.length === 0) {
      msgEl.textContent = "还没有任何投票，请使用上方表单创建第一个投票。";
      return;
    }

    msgEl.style.display = "none";
    tableEl.style.display = "";
    bodyEl.innerHTML = "";

    data.forEach((poll) => {
      const status = Utils.getPollStatus(poll);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${Utils.escapeHtml(poll.public_id)}</td>
        <td>${Utils.escapeHtml(poll.title)}</td>
        <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        <td>${poll.is_published ? "✅" : "❌"}</td>
        <td>${poll.is_closed ? "✅" : "❌"}</td>
        <td class="admin-actions"></td>
      `;

      const actionsCell = tr.querySelector(".admin-actions");

      const editBtn = document.createElement("button");
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", () => loadPollIntoForm(poll));
      actionsCell.appendChild(editBtn);

      const publishBtn = document.createElement("button");
      publishBtn.textContent = poll.is_published ? "取消发布" : "发布";
      publishBtn.addEventListener("click", () => togglePublish(poll));
      actionsCell.appendChild(publishBtn);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = poll.is_closed ? "重新开放" : "关闭";
      closeBtn.addEventListener("click", () => toggleClosed(poll));
      actionsCell.appendChild(closeBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", () => deletePoll(poll));
      actionsCell.appendChild(deleteBtn);

      bodyEl.appendChild(tr);
    });
  }

  async function togglePublish(poll) {
    const { error } = await window.sb
      .from("polls")
      .update({ is_published: !poll.is_published })
      .eq("id", poll.id);
    if (error) {
      alert(Utils.friendlyError(error, "admin"));
      return;
    }
    await refreshList();
  }

  async function toggleClosed(poll) {
    const confirmMsg = poll.is_closed ? "确定要重新开放该投票吗？" : "确定要关闭该投票吗？关闭后将无法继续投票。";
    if (!confirm(confirmMsg)) return;
    const { error } = await window.sb
      .from("polls")
      .update({ is_closed: !poll.is_closed })
      .eq("id", poll.id);
    if (error) {
      alert(Utils.friendlyError(error, "admin"));
      return;
    }
    await refreshList();
  }

  async function deletePoll(poll) {
    if (!confirm("确定要删除投票《" + poll.title + "》吗？此操作不可恢复，将同时删除其所有选项与投票记录。")) return;

    // 手动级联删除，避免因外键约束导致删除失败
    const optionIds = (poll.poll_options || []).map((o) => o.id);

    if (optionIds.length > 0) {
      const { error: voteDelError } = await window.sb.from("votes").delete().in("option_id", optionIds);
      if (voteDelError) {
        alert("删除投票记录时出错：" + Utils.friendlyError(voteDelError, "admin"));
        return;
      }
    }

    const { error: optDelError } = await window.sb.from("poll_options").delete().eq("poll_id", poll.id);
    if (optDelError) {
      alert("删除选项时出错：" + Utils.friendlyError(optDelError, "admin"));
      return;
    }

    const { error: settingsDelError } = await window.sb.from("poll_settings").delete().eq("poll_id", poll.id);
    if (settingsDelError) {
      alert("删除投票设置时出错：" + Utils.friendlyError(settingsDelError, "admin"));
      return;
    }

    const { error: pollDelError } = await window.sb.from("polls").delete().eq("id", poll.id);
    if (pollDelError) {
      alert("删除投票时出错：" + Utils.friendlyError(pollDelError, "admin"));
      return;
    }

    if (editingPollId === poll.id) resetFormToCreateMode();
    await refreshList();
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    Auth.initToolbar("toolbar");

    const ctx = await Auth.requireAdminOrRedirect();
    if (!ctx) return;

    document.getElementById("admin-area").style.display = "";

    resetFormToCreateMode();
    document.getElementById("poll-form").addEventListener("submit", handleFormSubmit);
    document.getElementById("btn-add-option").addEventListener("click", () => addOptionRow(""));
    document.getElementById("btn-cancel-edit").addEventListener("click", resetFormToCreateMode);
    document.getElementById("btn-refresh-list").addEventListener("click", refreshList);

    await refreshList();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
