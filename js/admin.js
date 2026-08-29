/* ============================================================
   js/admin.js
   VoteZone 管理后台逻辑

   说明：
   1. 前端只负责 UI 和调用 Supabase
   2. 管理员权限由 Supabase RLS / RPC 决定
   3. 不使用 service_role key
   4. 创建投票通过 create_poll RPC 一次性完成
   5. public_id 由数据库生成
   ============================================================ */

(function () {
  let editingPollId = null;
  let optionRowSeq = 0;

  /* ==========================================================
     工具：选项编辑器
     ========================================================== */

  function addOptionRow(text, existingId) {
    const container = document.getElementById("options-editor");

    if (!container) return;

    const rowId = "opt-row-" + optionRowSeq++;

    const row = document.createElement("div");
    row.className = "option-editor-row";
    row.dataset.existingId = existingId || "";
    row.id = rowId;

    const input = document.createElement("input");
    input.type = "text";
    input.value = text || "";
    input.maxLength = 200;
    input.placeholder = "选项内容";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove-option";
    removeBtn.textContent = "删除";

    removeBtn.addEventListener("click", () => {
      row.remove();
    });

    row.appendChild(input);
    row.appendChild(removeBtn);

    container.appendChild(row);
  }


  function clearOptionRows() {
    const container = document.getElementById("options-editor");

    if (container) {
      container.innerHTML = "";
    }
  }


  function collectOptions() {
    const rows = Array.from(
      document.querySelectorAll(
        "#options-editor .option-editor-row"
      )
    );

    return rows
      .map((row, idx) => ({
        existingId: row.dataset.existingId || null,

        option_text:
          row
            .querySelector("input[type='text']")
            ?.value
            .trim() || "",

        option_order: idx
      }))
      .filter((o) => o.option_text.length > 0);
  }


  /* ==========================================================
     表单状态
     ========================================================== */

  function resetFormToCreateMode() {
    editingPollId = null;

    const editingId =
      document.getElementById("editing-poll-id");

    const titleBar =
      document.getElementById("form-title-bar");

    const submitBtn =
      document.getElementById("poll-form-submit");

    const cancelBtn =
      document.getElementById("btn-cancel-edit");

    const form =
      document.getElementById("poll-form");

    if (editingId) {
      editingId.value = "";
    }

    if (titleBar) {
      titleBar.textContent = "➕ 创建新投票";
    }

    if (submitBtn) {
      submitBtn.textContent = "创建投票";
    }

    if (cancelBtn) {
      cancelBtn.style.display = "none";
    }

    if (form) {
      form.reset();
    }

    clearOptionRows();

    addOptionRow("");
    addOptionRow("");

    setFormMsg(null, null);
  }


  function loadPollIntoForm(poll) {
    editingPollId = poll.id;

    const editingId =
      document.getElementById("editing-poll-id");

    const titleBar =
      document.getElementById("form-title-bar");

    const submitBtn =
      document.getElementById("poll-form-submit");

    const cancelBtn =
      document.getElementById("btn-cancel-edit");

    if (editingId) {
      editingId.value = poll.id;
    }

    if (titleBar) {
      titleBar.textContent =
        "✏️ 编辑投票：" + poll.title;
    }

    if (submitBtn) {
      submitBtn.textContent = "保存修改";
    }

    if (cancelBtn) {
      cancelBtn.style.display = "";
    }

    document.getElementById("f-title").value =
      poll.title || "";

    document.getElementById("f-desc").value =
      poll.description || "";

    document.getElementById("f-start").value =
      Utils.toDateTimeLocalValue(poll.start_time);

    document.getElementById("f-end").value =
      Utils.toDateTimeLocalValue(poll.end_time);


    const settings =
      Array.isArray(poll.poll_settings)
        ? poll.poll_settings[0]
        : poll.poll_settings;


    document.getElementById("f-allow-multi").checked =
      !!(
        settings &&
        settings.allow_multiple_choices
      );

    document.getElementById("f-show-results").checked =
      !!(
        settings &&
        settings.show_results_before_end
      );

    document.getElementById("f-randomize").checked =
      !!(
        settings &&
        settings.randomize_options
      );


    clearOptionRows();

    const opts =
      (poll.poll_options || [])
        .slice()
        .sort(
          (a, b) =>
            a.option_order - b.option_order
        );


    if (opts.length === 0) {
      addOptionRow("");
      addOptionRow("");
    } else {
      opts.forEach((o) => {
        addOptionRow(
          o.option_text,
          o.id
        );
      });
    }

    setFormMsg(null, null);

    const form =
      document.getElementById("poll-form");

    if (form) {
      form.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }
  }


  function setFormMsg(errorText, successText) {
    const errEl =
      document.getElementById("form-error");

    const okEl =
      document.getElementById("form-success");

    if (errEl) {
      if (errorText) {
        errEl.textContent = errorText;
        errEl.style.display = "";
      } else {
        errEl.style.display = "none";
      }
    }

    if (okEl) {
      if (successText) {
        okEl.textContent = successText;
        okEl.style.display = "";
      } else {
        okEl.style.display = "none";
      }
    }
  }


  /* ==========================================================
     表单提交
     ========================================================== */

  async function handleFormSubmit(e) {
    e.preventDefault();

    setFormMsg(null, null);


    const title =
      document.getElementById("f-title")
        .value
        .trim();

    const description =
      document.getElementById("f-desc")
        .value
        .trim();

    const startLocal =
      document.getElementById("f-start")
        .value;

    const endLocal =
      document.getElementById("f-end")
        .value;

    const allowMulti =
      document.getElementById("f-allow-multi")
        .checked;

    const showResults =
      document.getElementById("f-show-results")
        .checked;

    const randomize =
      document.getElementById("f-randomize")
        .checked;

    const options =
      collectOptions();


    /* ---------------- 基础验证 ---------------- */

    if (!title) {
      setFormMsg("请填写投票标题。");
      return;
    }

    if (!startLocal || !endLocal) {
      setFormMsg("请填写开始和结束时间。");
      return;
    }


    const startDate =
      new Date(startLocal);

    const endDate =
      new Date(endLocal);


    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime())
    ) {
      setFormMsg("时间格式无效。");
      return;
    }


    if (endDate <= startDate) {
      setFormMsg(
        "结束时间必须晚于开始时间。"
      );
      return;
    }


    if (options.length < 2) {
      setFormMsg(
        "至少需要 2 个有效选项。"
      );
      return;
    }


    const startISO =
      startDate.toISOString();

    const endISO =
      endDate.toISOString();


    const submitBtn =
      document.getElementById(
        "poll-form-submit"
      );


    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent =
        "保存中...";
    }


    try {

      const {
        user
      } = await Auth.getCurrentUserAndProfile();


      if (!user) {
        setFormMsg(
          "登录状态已失效，请重新登录。"
        );
        return;
      }


      if (!editingPollId) {

        await createPoll({
          title,
          description,
          startISO,
          endISO,
          allowMulti,
          showResults,
          randomize,
          options
        });

      } else {

        await updatePoll({
          pollId: editingPollId,
          title,
          description,
          startISO,
          endISO,
          allowMulti,
          showResults,
          randomize,
          options
        });

      }

    } catch (error) {

      console.error(
        "[admin.js] handleFormSubmit:",
        error
      );

      setFormMsg(
        error?.message ||
        "保存投票时发生未知错误。"
      );

    } finally {

      if (submitBtn) {
        submitBtn.disabled = false;

        submitBtn.textContent =
          editingPollId
            ? "保存修改"
            : "创建投票";
      }
    }
  }


  /* ==========================================================
     创建投票
     
     现在通过 Supabase RPC：
     
     create_poll()
     
     一次性创建：
     polls
     poll_settings
     poll_options
     
     public_id 也由数据库生成。
     ========================================================== */

  async function createPoll(p) {

    const {
      data,
      error
    } = await window.sb.rpc(
      "create_poll",
      {
        p_title:
          p.title,

        p_description:
          p.description || null,

        p_start_time:
          p.startISO,

        p_end_time:
          p.endISO,

        p_allow_multiple_choices:
          p.allowMulti,

        p_show_results_before_end:
          p.showResults,

        p_randomize_options:
          p.randomize,

        p_options:
          p.options.map((o) => ({
            option_text:
              o.option_text,

            option_order:
              o.option_order
          }))
      }
    );


    if (error) {

      console.error(
        "[admin.js] create_poll RPC error:",
        error
      );


      const message =
        error.message || "";


      if (
        message.includes(
          "NOT_AUTHENTICATED"
        )
      ) {
        setFormMsg(
          "登录状态已失效，请重新登录。"
        );
        return;
      }


      if (
        message.includes(
          "NOT_ADMIN"
        )
      ) {
        setFormMsg(
          "没有管理员权限。"
        );
        return;
      }


      if (
        message.includes(
          "TITLE_REQUIRED"
        )
      ) {
        setFormMsg(
          "请填写投票标题。"
        );
        return;
      }


      if (
        message.includes(
          "TIME_REQUIRED"
        )
      ) {
        setFormMsg(
          "请填写开始和结束时间。"
        );
        return;
      }


      if (
        message.includes(
          "INVALID_TIME_RANGE"
        )
      ) {
        setFormMsg(
          "结束时间必须晚于开始时间。"
        );
        return;
      }


      if (
        message.includes(
          "AT_LEAST_TWO_OPTIONS_REQUIRED"
        ) ||
        message.includes(
          "AT_LEAST_TWO_VALID_OPTIONS_REQUIRED"
        )
      ) {
        setFormMsg(
          "至少需要 2 个有效选项。"
        );
        return;
      }


      setFormMsg(
        "创建投票失败：" +
        Utils.friendlyError(
          error,
          "admin"
        )
      );

      return;
    }


    if (
      !data ||
      !data.id ||
      !data.public_id
    ) {

      console.error(
        "[admin.js] create_poll returned invalid data:",
        data
      );

      setFormMsg(
        "投票创建成功，但数据库没有返回投票编号。"
      );

      return;
    }


    setFormMsg(
      null,

      "投票创建成功！编号：" +
      data.public_id +
      "（当前为未发布状态，请在下方列表点击「发布」）"
    );


    resetFormToCreateMode();

    await refreshList();
  }


  /* ==========================================================
     编辑投票
     ========================================================== */

  async function updatePoll(p) {

    /* ---------------- 更新基本信息 ---------------- */

    const {
      error: pollError
    } = await window.sb
      .from("polls")
      .update({
        title:
          p.title,

        description:
          p.description || null,

        start_time:
          p.startISO,

        end_time:
          p.endISO
      })
      .eq("id", p.pollId);


    if (pollError) {

      setFormMsg(
        "更新投票失败：" +
        Utils.friendlyError(
          pollError,
          "admin"
        )
      );

      return;
    }


    /* ---------------- 更新设置 ---------------- */

    const {
      error: settingsError
    } = await window.sb
      .from("poll_settings")
      .upsert(
        {
          poll_id:
            p.pollId,

          allow_multiple_choices:
            p.allowMulti,

          show_results_before_end:
            p.showResults,

          randomize_options:
            p.randomize
        },
        {
          onConflict:
            "poll_id"
        }
      );


    if (settingsError) {

      setFormMsg(
        "投票基本信息已更新，但保存投票设置时出错：" +
        Utils.friendlyError(
          settingsError,
          "admin"
        )
      );

      await refreshList();

      return;
    }


    /* ---------------- 获取旧选项 ---------------- */

    const {
      data: existingOptions,
      error: fetchOptError
    } = await window.sb
      .from("poll_options")
      .select("id")
      .eq(
        "poll_id",
        p.pollId
      );


    if (fetchOptError) {

      setFormMsg(
        "读取旧选项时出错：" +
        Utils.friendlyError(
          fetchOptError,
          "admin"
        )
      );

      await refreshList();

      return;
    }


    const existingIds =
      new Set(
        (existingOptions || [])
          .map((o) => o.id)
      );


    const submittedIds =
      new Set(
        p.options
          .filter(
            (o) => o.existingId
          )
          .map(
            (o) => Number(o.existingId)
          )
      );


    const toUpdate =
      p.options.filter(
        (o) => o.existingId
      );


    const toInsert =
      p.options.filter(
        (o) => !o.existingId
      );


    const toDeleteIds =
      Array.from(existingIds)
        .filter(
          (id) =>
            !submittedIds.has(
              Number(id)
            )
        );


    /* ---------------- 更新旧选项 ---------------- */

    for (const o of toUpdate) {

      const {
        error
      } = await window.sb
        .from("poll_options")
        .update({
          option_text:
            o.option_text,

          option_order:
            o.option_order
        })
        .eq(
          "id",
          o.existingId
        );


      if (error) {

        setFormMsg(
          "更新选项时出错：" +
          Utils.friendlyError(
            error,
            "admin"
          )
        );

        await refreshList();

        return;
      }
    }


    /* ---------------- 插入新选项 ---------------- */

    if (toInsert.length > 0) {

      const {
        error
      } = await window.sb
        .from("poll_options")
        .insert(
          toInsert.map((o) => ({
            poll_id:
              p.pollId,

            option_text:
              o.option_text,

            option_order:
              o.option_order
          }))
        );


      if (error) {

        setFormMsg(
          "新增选项时出错：" +
          Utils.friendlyError(
            error,
            "admin"
          )
        );

        await refreshList();

        return;
      }
    }


    /* ---------------- 删除被移除的选项 ---------------- */

    if (toDeleteIds.length > 0) {

      const {
        error
      } = await window.sb
        .from("poll_options")
        .delete()
        .in(
          "id",
          toDeleteIds
        );


      if (error) {

        setFormMsg(
          "删除旧选项时出错：" +
          Utils.friendlyError(
            error,
            "admin"
          ) +
          "。如果这些选项已经存在投票记录，请先处理相关投票记录。"
        );

        await refreshList();

        return;
      }
    }


    setFormMsg(
      null,
      "投票已更新。"
    );


    resetFormToCreateMode();

    await refreshList();
  }


  /* ==========================================================
     管理员投票列表
     ========================================================== */

  async function refreshList() {

    const msgEl =
      document.getElementById(
        "admin-list-msg"
      );

    const tableEl =
      document.getElementById(
        "admin-poll-table"
      );

    const bodyEl =
      document.getElementById(
        "admin-poll-body"
      );


    if (!msgEl || !tableEl || !bodyEl) {
      return;
    }


    msgEl.textContent =
      "正在读取投票列表...";

    msgEl.className =
      "info-box";

    msgEl.style.display =
      "";

    tableEl.style.display =
      "none";


    const {
      data,
      error
    } = await window.sb
      .from("polls")
      .select(
        "*, poll_options(*), poll_settings(*)"
      )
      .order(
        "created_at",
        {
          ascending: false
        }
      );


    if (error) {

      console.error(
        "[admin.js] refreshList:",
        error
      );

      msgEl.textContent =
        Utils.friendlyError(
          error,
          "admin"
        );

      msgEl.className =
        "error-box";

      return;
    }


    if (
      !data ||
      data.length === 0
    ) {

      msgEl.textContent =
        "还没有任何投票，请使用上方表单创建第一个投票。";

      return;
    }


    msgEl.style.display =
      "none";

    tableEl.style.display =
      "";

    bodyEl.innerHTML =
      "";


    data.forEach((poll) => {

      const status =
        Utils.getPollStatus(
          poll
        );


      const tr =
        document.createElement(
          "tr"
        );


      tr.innerHTML = `
        <td>${Utils.escapeHtml(String(poll.public_id))}</td>
        <td>${Utils.escapeHtml(poll.title || "")}</td>
        <td>
          <span class="badge ${Utils.escapeHtml(status.badgeClass || "")}">
            ${Utils.escapeHtml(status.label || "")}
          </span>
        </td>
        <td>${poll.is_published ? "✅" : "❌"}</td>
        <td>${poll.is_closed ? "✅" : "❌"}</td>
        <td class="admin-actions"></td>
      `;


      const actionsCell =
        tr.querySelector(
          ".admin-actions"
        );


      /* ---------------- 编辑 ---------------- */

      const editBtn =
        document.createElement(
          "button"
        );

      editBtn.type =
        "button";

      editBtn.textContent =
        "编辑";

      editBtn.addEventListener(
        "click",
        () =>
          loadPollIntoForm(
            poll
          )
      );

      actionsCell.appendChild(
        editBtn
      );


      /* ---------------- 发布 / 取消发布 ---------------- */

      const publishBtn =
        document.createElement(
          "button"
        );

      publishBtn.type =
        "button";

      publishBtn.textContent =
        poll.is_published
          ? "取消发布"
          : "发布";

      publishBtn.addEventListener(
        "click",
        () =>
          togglePublish(
            poll
          )
      );

      actionsCell.appendChild(
        publishBtn
      );


      /* ---------------- 关闭 / 重新开放 ---------------- */

      const closeBtn =
        document.createElement(
          "button"
        );

      closeBtn.type =
        "button";

      closeBtn.textContent =
        poll.is_closed
          ? "重新开放"
          : "关闭";

      closeBtn.addEventListener(
        "click",
        () =>
          toggleClosed(
            poll
          )
      );

      actionsCell.appendChild(
        closeBtn
      );


      /* ---------------- 删除 ---------------- */

      const deleteBtn =
        document.createElement(
          "button"
        );

      deleteBtn.type =
        "button";

      deleteBtn.textContent =
        "删除";

      deleteBtn.addEventListener(
        "click",
        () =>
          deletePoll(
            poll
          )
      );

      actionsCell.appendChild(
        deleteBtn
      );


      bodyEl.appendChild(
        tr
      );
    });
  }


  /* ==========================================================
     发布 / 取消发布
     ========================================================== */

  async function togglePublish(poll) {

    const nextState =
      !poll.is_published;


    const {
      error
    } = await window.sb
      .from("polls")
      .update({
        is_published:
          nextState
      })
      .eq(
        "id",
        poll.id
      );


    if (error) {

      alert(
        Utils.friendlyError(
          error,
          "admin"
        )
      );

      return;
    }


    await refreshList();
  }


  /* ==========================================================
     关闭 / 重新开放
     ========================================================== */

  async function toggleClosed(poll) {

    const confirmMsg =
      poll.is_closed
        ? "确定要重新开放该投票吗？"
        : "确定要关闭该投票吗？关闭后将无法继续投票。";


    if (!confirm(confirmMsg)) {
      return;
    }


    const {
      error
    } = await window.sb
      .from("polls")
      .update({
        is_closed:
          !poll.is_closed
      })
      .eq(
        "id",
        poll.id
      );


    if (error) {

      alert(
        Utils.friendlyError(
          error,
          "admin"
        )
      );

      return;
    }


    await refreshList();
  }


  /* ==========================================================
     删除投票
     
     你的数据库表已经设置了：
     
     poll_options -> polls ON DELETE CASCADE
     poll_settings -> polls ON DELETE CASCADE
     votes -> poll_options ON DELETE CASCADE
     
     因此这里直接删除 polls 即可让数据库级联清理。
     ========================================================== */

  async function deletePoll(poll) {

    const confirmed =
      confirm(
        "确定要删除投票《" +
        poll.title +
        "》吗？\n\n" +
        "此操作不可恢复，并会同时删除其选项、设置以及投票记录。"
      );


    if (!confirmed) {
      return;
    }


    const {
      error
    } = await window.sb
      .from("polls")
      .delete()
      .eq(
        "id",
        poll.id
      );


    if (error) {

      console.error(
        "[admin.js] deletePoll:",
        error
      );

      alert(
        "删除投票失败：" +
        Utils.friendlyError(
          error,
          "admin"
        )
      );

      return;
    }


    if (
      editingPollId &&
      Number(editingPollId) ===
      Number(poll.id)
    ) {
      resetFormToCreateMode();
    }


    await refreshList();
  }


  /* ==========================================================
     初始化
     ========================================================== */

  async function init() {

    try {

      Auth.initToolbar(
        "toolbar"
      );


      const ctx =
        await Auth.requireAdminOrRedirect();


      if (!ctx) {
        return;
      }


      const adminArea =
        document.getElementById(
          "admin-area"
        );


      if (adminArea) {
        adminArea.style.display =
          "";
      }


      resetFormToCreateMode();


      const form =
        document.getElementById(
          "poll-form"
        );


      if (form) {
        form.addEventListener(
          "submit",
          handleFormSubmit
        );
      }


      const addOptionBtn =
        document.getElementById(
          "btn-add-option"
        );


      if (addOptionBtn) {
        addOptionBtn.addEventListener(
          "click",
          () =>
            addOptionRow("")
        );
      }


      const cancelBtn =
        document.getElementById(
          "btn-cancel-edit"
        );


      if (cancelBtn) {
        cancelBtn.addEventListener(
          "click",
          resetFormToCreateMode
        );
      }


      const refreshBtn =
        document.getElementById(
          "btn-refresh-list"
        );


      if (refreshBtn) {
        refreshBtn.addEventListener(
          "click",
          refreshList
        );
      }


      await refreshList();

    } catch (error) {

      console.error(
        "[admin.js] init:",
        error
      );

      const msgEl =
        document.getElementById(
          "admin-list-msg"
        );

      if (msgEl) {

        msgEl.textContent =
          "管理后台初始化失败：" +
          (
            error?.message ||
            "未知错误"
          );

        msgEl.className =
          "error-box";

        msgEl.style.display =
          "";
      }
    }
  }


  document.addEventListener(
    "DOMContentLoaded",
    init
  );

})();
