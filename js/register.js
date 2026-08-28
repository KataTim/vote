/* ============================================================
   js/register.js
   注册页逻辑：supabase.auth.signUp() + 写入 profiles 行。

   注意：由于关闭了邮箱验证，signUp() 成功后应当直接返回
   一个可用的 session。这里同时做了防御性处理：如果某天
   项目重新开启了邮箱验证，也不会白屏报错，而是提示用户
   去邮箱确认。
   ============================================================ */

(function () {
  async function checkAlreadyLoggedIn() {
    const { user } = await Auth.getCurrentUserAndProfile();
    if (user) {
      document.getElementById("already-logged-in").style.display = "";
      document.getElementById("register-form").style.display = "none";
    }
  }

  function showError(message) {
    const box = document.getElementById("register-error");
    box.textContent = message;
    box.style.display = "";
  }
  function hideError() {
    document.getElementById("register-error").style.display = "none";
  }
  function showSuccess(message) {
    const box = document.getElementById("register-success");
    box.textContent = message;
    box.style.display = "";
  }

  async function handleSubmit(e) {
    e.preventDefault();
    hideError();

    const username = document.getElementById("reg-username").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-password").value;
    const password2 = document.getElementById("reg-password2").value;
    const submitBtn = document.getElementById("register-submit");

    if (!username || !email || !password || !password2) {
      showError("请完整填写所有字段。");
      return;
    }
    if (password !== password2) {
      showError("两次输入的密码不一致。");
      return;
    }
    if (password.length < 6) {
      showError("密码长度至少需要 6 位。");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "注册中...";

    const { data, error } = await window.sb.auth.signUp({
      email,
      password,
      options: {
        data: { username: username },
      },
    });

    if (error) {
      submitBtn.disabled = false;
      submitBtn.textContent = "注 册";
      showError(Utils.friendlyError(error, "register"));
      return;
    }

    // 关闭邮箱验证时，signUp 会直接返回 session。
    if (!data.session) {
      submitBtn.disabled = false;
      submitBtn.textContent = "注 册";
      showSuccess("注册请求已提交。如项目已开启邮箱验证，请前往邮箱完成确认后再登录；否则请稍后直接登录。");
      return;
    }

    // 写入 profiles 行 (需要数据库 RLS 允许 id = auth.uid() 的用户自行 insert)
    const user = data.user;
    const { error: profileError } = await window.sb.from("profiles").insert({
      id: user.id,
      username: username,
      display_name: username,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "注 册";

    if (profileError) {
      // 账号已经创建成功，只是资料行写入失败，给出清晰提示而不是掩盖错误
      showError(
        "账号已创建，但保存用户资料时出错：" +
        Utils.friendlyError(profileError, "register") +
        " 请联系管理员检查 profiles 表的 RLS 策略。"
      );
      return;
    }

    Auth.clearProfileCache();
    window.location.href = "index.html";
  }

  document.addEventListener("DOMContentLoaded", () => {
    Auth.initToolbar("toolbar");
    checkAlreadyLoggedIn();
    document.getElementById("register-form").addEventListener("submit", handleSubmit);
  });
})();
