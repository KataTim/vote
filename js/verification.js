/* ============================================================
   js/verification.js
   个人资料 + 身份验证三步流程。

   安全要点（对应 sql/verification.sql）：
   - verification_status 等字段完全由 submit_verification_request() /
     review_verification_request() 两个数据库函数改动，本文件从头到尾
     不会直接 UPDATE profiles 的验证相关字段。
   - 验证任务的正确答案永远不会出现在这个文件里：题目由
     generate_verification_challenge() 生成并只返回题面，答案由
     submit_verification_challenge_answer() 在数据库里比对。
   - IP / 设备指纹的哈希、风险等级计算都在 record_security_signals()
     里完成，本文件只负责收集"非隐蔽"的浏览器基础信息（UA、语言、
     屏幕分辨率、时区等）发给后端，不做任何前端可见的风险判断。
   ============================================================ */

(function () {
  let currentUser = null;
  let currentProfile = null;
  let currentChallenge = null; // { id, type, prompt }
  let passedChallengeId = null;

  /* ---------------- 资料读取 / 渲染 ---------------- */

  async function fetchFullProfile(userId) {
    const { data, error } = await window.sb
      .from("profiles")
      .select("id, username, display_name, avatar_url, qq_number, is_admin, verification_status, verification_submitted_at, verification_reviewed_at, verification_note")
      .eq("id", userId)
      .single();
    if (error) {
      console.warn("[verification.js] 读取资料失败：", error.message);
      return null;
    }
    return data;
  }

  function renderStatusArea(profile) {
    const info = Utils.verificationStatusInfo(profile.verification_status);
    const badge = document.getElementById("status-badge");
    badge.textContent = info.label;
    badge.className = "badge " + info.cls;

    const noteBox = document.getElementById("review-note-box");
    if (profile.verification_note) {
      noteBox.style.display = "";
      noteBox.textContent =
        "管理员留言（" + Utils.formatDateTime(profile.verification_reviewed_at) + "）：" +
        profile.verification_note;
    } else {
      noteBox.style.display = "none";
    }
  }

  function fillProfileForm(profile) {
    document.getElementById("p-username").value = profile.username || "";
    document.getElementById("p-qq").value = profile.qq_number || "";
    const preview = document.getElementById("avatar-preview");
    if (profile.avatar_url) {
      preview.src = profile.avatar_url;
      preview.style.display = "";
    } else {
      preview.style.display = "none";
    }
  }

  function isProfileComplete(profile) {
    return !!(profile.username && profile.username.trim() &&
      profile.avatar_url && profile.avatar_url.trim() &&
      profile.qq_number && profile.qq_number.trim());
  }

  /* ---------------- 保存资料 ---------------- */

  function setProfileMsg(errorText, successText) {
    const errEl = document.getElementById("profile-error");
    const okEl = document.getElementById("profile-success");
    errEl.style.display = errorText ? "" : "none";
    if (errorText) errEl.textContent = errorText;
    okEl.style.display = successText ? "" : "none";
    if (successText) okEl.textContent = successText;
  }

  async function uploadAvatarIfNeeded() {
    const fileInput = document.getElementById("p-avatar-file");
    const file = fileInput.files && fileInput.files[0];
    if (!file) return currentProfile.avatar_url || null;

    if (file.size > 2 * 1024 * 1024) {
      throw new Error("头像文件不能超过 2MB。");
    }

    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = currentUser.id + "/avatar." + ext;

    const { error: uploadError } = await window.sb.storage
      .from("avatars")
      .upload(path, file, { upsert: true, cacheControl: "3600" });

    if (uploadError) {
      throw new Error("头像上传失败：" + uploadError.message);
    }

    const { data } = window.sb.storage.from("avatars").getPublicUrl(path);
    // 加上时间戳避免浏览器缓存旧头像
    return data.publicUrl + "?t=" + Date.now();
  }

  async function handleProfileSubmit(e) {
    e.preventDefault();
    setProfileMsg(null, null);

    const username = document.getElementById("p-username").value.trim();
    const qq = document.getElementById("p-qq").value.trim();

    if (!username) {
      setProfileMsg("请填写用户名。");
      return;
    }
    if (!/^[0-9]{5,15}$/.test(qq)) {
      setProfileMsg("QQ 号格式不正确，应为 5-15 位数字。");
      return;
    }

    const btn = document.getElementById("profile-save-btn");
    btn.disabled = true;
    btn.textContent = "保存中...";

    try {
      const avatarUrl = await uploadAvatarIfNeeded();

      const { error } = await window.sb
        .from("profiles")
        .update({ username, qq_number: qq, avatar_url: avatarUrl })
        .eq("id", currentUser.id);

      if (error) {
        setProfileMsg(Utils.friendlyError(error, "verification"));
        return;
      }

      currentProfile = await fetchFullProfile(currentUser.id);
      fillProfileForm(currentProfile);
      renderStatusArea(currentProfile);
      setProfileMsg(null, "资料已保存。");
      refreshWizardVisibility();
      Auth.clearProfileCache();
      Auth.refreshToolbar("toolbar");
    } catch (err) {
      setProfileMsg(err.message || "保存失败，请重试。");
    } finally {
      btn.disabled = false;
      btn.textContent = "保存资料";
    }
  }

  /* ---------------- 安全信号上报（静默，不向用户展示细节） ---------------- */

  function collectDeviceFingerprint() {
    try {
      const parts = [
        navigator.userAgent || "",
        navigator.language || "",
        String(screen.width) + "x" + String(screen.height),
        String(screen.colorDepth || ""),
        Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        String(navigator.hardwareConcurrency || ""),
        navigator.platform || "",
      ];
      return parts.join("|");
    } catch (e) {
      return "";
    }
  }

  async function reportSecuritySignalsOnce() {
    try {
      await window.sb.rpc("record_security_signals", {
        p_device_fingerprint: collectDeviceFingerprint(),
      });
    } catch (e) {
      console.warn("[verification.js] 记录安全信号失败（不影响正常使用）：", e);
    }
  }

  /* ---------------- 向导：可见性 / 步骤切换 ---------------- */

  function setStep(stepNum) {
    [1, 2, 3].forEach((n) => {
      document.getElementById("step-" + n).style.display = n === stepNum ? "" : "none";
      const ind = document.getElementById("step-ind-" + n);
      ind.classList.remove("active", "done");
      if (n < stepNum) ind.classList.add("done");
      if (n === stepNum) ind.classList.add("active");
    });
  }

  function refreshWizardVisibility() {
    const blockedEl = document.getElementById("wizard-blocked-msg");
    const contentEl = document.getElementById("wizard-content");
    const status = currentProfile.verification_status;

    if (status === "pending") {
  blockedEl.style.display = "";
  blockedEl.textContent =
    "您的身份验证申请正在审核中，请耐心等待管理员处理。";
  contentEl.style.display = "none";
  return;
}


if (status === "verified") {
  blockedEl.style.display = "";
  blockedEl.textContent =
    "您已经通过身份验证，无需重复申请。";
  contentEl.style.display = "none";
  return;
}


if (status === "rejected") {
  blockedEl.style.display = "";
  blockedEl.textContent =
    "您的身份验证申请已被拒绝，请查看管理员留言后重新提交。";
  contentEl.style.display = "";
  setStep(1);
  return;
}


if (status === "needs_more_info") {
  blockedEl.style.display = "";
  blockedEl.textContent =
    "管理员要求补充资料，请修改资料后重新提交申请。";
  contentEl.style.display = "";
  setStep(1);
  return;
}

    blockedEl.style.display = "none";
    contentEl.style.display = "";
    setStep(1);
  }

  /* ---------------- Step 2：验证任务 ---------------- */

  function resetChallengeUi() {
    document.getElementById("challenge-error").style.display = "none";
    document.getElementById("challenge-success").style.display = "none";
    document.getElementById("challenge-math-area").style.display = "none";
    document.getElementById("challenge-click-area").style.display = "none";
    document.getElementById("challenge-click-area").innerHTML = "";
    document.getElementById("step2-next").style.display = "none";
    document.getElementById("challenge-answer-input").value = "";
    document.getElementById("challenge-answer-input").disabled = false;
    document.getElementById("challenge-submit-btn").disabled = false;
  }

  function shuffleArr(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function randomCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  async function loadChallenge() {
    resetChallengeUi();
    passedChallengeId = null;
    document.getElementById("challenge-prompt").textContent = "正在生成任务...";

    const { data, error } = await window.sb.rpc("generate_verification_challenge");
    if (error) {
      document.getElementById("challenge-prompt").textContent = "";
      document.getElementById("challenge-error").style.display = "";
      document.getElementById("challenge-error").textContent = Utils.friendlyError(error, "verification");
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    currentChallenge = { id: row.challenge_id, type: row.challenge_type, prompt: row.prompt };
    document.getElementById("challenge-prompt").textContent = currentChallenge.prompt;

    if (currentChallenge.type === "math") {
      document.getElementById("challenge-math-area").style.display = "";
    } else {
      const match = currentChallenge.prompt.match(/「(.+?)」/);
      const realCode = match ? match[1] : "";
      const decoys = [];
      while (decoys.length < 5) {
        const c = randomCode();
        if (c !== realCode && decoys.indexOf(c) === -1) decoys.push(c);
      }
      const buttons = shuffleArr([realCode, ...decoys]);
      const area = document.getElementById("challenge-click-area");
      area.style.display = "";
      buttons.forEach((code) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = code;
        b.addEventListener("click", () => submitChallengeAnswer(code));
        area.appendChild(b);
      });
    }
  }

  async function submitChallengeAnswer(answer) {
    if (!currentChallenge) return;
    document.getElementById("challenge-error").style.display = "none";

    const { data, error } = await window.sb.rpc("submit_verification_challenge_answer", {
      p_challenge_id: currentChallenge.id,
      p_answer: answer,
    });

    if (error) {
      document.getElementById("challenge-error").style.display = "";
      document.getElementById("challenge-error").textContent = Utils.friendlyError(error, "verification");
      return;
    }

    if (data === true) {
      passedChallengeId = currentChallenge.id;
      document.getElementById("challenge-success").style.display = "";
      document.getElementById("challenge-success").textContent = "验证通过！";
      document.getElementById("step2-next").style.display = "";
      document.getElementById("challenge-answer-input").disabled = true;
      document.getElementById("challenge-submit-btn").disabled = true;
      Array.from(document.querySelectorAll("#challenge-click-area button")).forEach((b) => (b.disabled = true));
    } else {
      document.getElementById("challenge-error").style.display = "";
      document.getElementById("challenge-error").textContent = "答案不正确，请点击「换一个任务」重试。";
    }
  }

  /* ---------------- Step 3：提交申请 ---------------- */

  async function handleSubmitRequest() {
    const errEl = document.getElementById("submit-error");
    errEl.style.display = "none";

    const reason = document.getElementById("reason-input").value.trim();
    if (reason.length < 5) {
      errEl.style.display = "";
      errEl.textContent = "请填写更详细一点的申请理由（至少 5 个字）。";
      return;
    }
    if (!passedChallengeId) {
      errEl.style.display = "";
      errEl.textContent = "请先完成第二步的验证任务。";
      return;
    }

    const btn = document.getElementById("submit-request-btn");
    btn.disabled = true;
    btn.textContent = "提交中...";

    await reportSecuritySignalsOnce();

    const { error } = await window.sb.rpc("submit_verification_request", {
      p_reason: reason,
      p_passed_challenge_id: passedChallengeId,
    });

    btn.disabled = false;
    btn.textContent = "提交身份验证申请";

    if (error) {
      errEl.style.display = "";
      errEl.textContent = Utils.friendlyError(error, "verification");
      return;
    }

    currentProfile = await fetchFullProfile(currentUser.id);
    renderStatusArea(currentProfile);
    refreshWizardVisibility();
    Auth.clearProfileCache();
    Auth.refreshToolbar("toolbar");
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    Auth.initToolbar("toolbar");

    const { user } = await Auth.getCurrentUserAndProfile();
    if (!user) {
      document.getElementById("not-logged-in").style.display = "";
      return;
    }
    currentUser = user;
    currentProfile = await fetchFullProfile(user.id);
    if (!currentProfile) {
      document.getElementById("not-logged-in").style.display = "";
      document.getElementById("not-logged-in").textContent = "读取资料失败，请刷新页面重试。";
      return;
    }

    document.getElementById("verification-area").style.display = "";
    fillProfileForm(currentProfile);
    renderStatusArea(currentProfile);
    refreshWizardVisibility();

    document.getElementById("profile-form").addEventListener("submit", handleProfileSubmit);
    document.getElementById("p-avatar-file").addEventListener("change", () => {
      const file = document.getElementById("p-avatar-file").files[0];
      if (!file) return;
      const preview = document.getElementById("avatar-preview");
      preview.src = URL.createObjectURL(file);
      preview.style.display = "";
    });

    document.getElementById("step1-next").addEventListener("click", () => {
      if (!isProfileComplete(currentProfile)) {
        alert("请先在上方完善用户名、头像和 QQ 号并保存。");
        return;
      }
      setStep(2);
      loadChallenge();
    });

    document.getElementById("challenge-refresh-btn").addEventListener("click", loadChallenge);
    document.getElementById("challenge-submit-btn").addEventListener("click", () => {
      const val = document.getElementById("challenge-answer-input").value.trim();
      if (!val) return;
      submitChallengeAnswer(val);
    });
    document.getElementById("step2-next").addEventListener("click", () => setStep(3));
    document.getElementById("submit-request-btn").addEventListener("click", handleSubmitRequest);
  }

  document.addEventListener("DOMContentLoaded", () => {
  // 原来的初始化代码
});


setInterval(async () => {
  if (!currentUser) return;

  const fresh = await fetchFullProfile(currentUser.id);

  if (fresh) {
    currentProfile = fresh;
    renderStatusArea(fresh);
    refreshWizardVisibility();
  }
}, 10000);

})();
