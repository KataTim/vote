/* ============================================================
   js/utils.js
   跨页面共用的小工具函数：日期格式化、投票状态计算、
   友好错误信息转换。挂载在 window.Utils 上。
   ============================================================ */

(function () {
  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatDateTime(isoString) {
    if (!isoString) return "-";
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "-";
    return (
      d.getFullYear() +
      "-" + pad(d.getMonth() + 1) +
      "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) +
      ":" + pad(d.getMinutes())
    );
  }

  // datetime-local <input> 需要的格式 (本地时间, 无时区)
  function toDateTimeLocalValue(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "";
    return (
      d.getFullYear() +
      "-" + pad(d.getMonth() + 1) +
      "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) +
      ":" + pad(d.getMinutes())
    );
  }

  /**
   * 计算投票的当前状态。
   * poll: { is_published, is_closed, start_time, end_time }
   * 返回 { code, label, badgeClass, canVote }
   */
  function getPollStatus(poll) {
    const now = new Date();
    const start = poll.start_time ? new Date(poll.start_time) : null;
    const end = poll.end_time ? new Date(poll.end_time) : null;

    if (!poll.is_published) {
      return { code: "draft", label: "未发布", badgeClass: "badge--draft", canVote: false };
    }
    if (poll.is_closed) {
      return { code: "closed", label: "已关闭", badgeClass: "badge--ended", canVote: false };
    }
    if (start && now < start) {
      return { code: "upcoming", label: "未开始", badgeClass: "badge--upcoming", canVote: false };
    }
    if (end && now > end) {
      return { code: "ended", label: "已结束", badgeClass: "badge--ended", canVote: false };
    }
    return { code: "live", label: "进行中", badgeClass: "badge--live", canVote: true };
  }

  /**
   * 把 Supabase / PostgREST 的原始错误转换成中文友好提示。
   * context 用于区分场景，比如 "login" | "register" | "vote" | "admin"
   */
  function friendlyError(error, context) {
    if (!error) return "发生未知错误，请重试。";

    const raw = (error.message || "").toLowerCase();
    const code = error.code || "";

    // 网络错误
    if (raw.includes("failed to fetch") || raw.includes("network")) {
      return "网络错误，请检查网络连接后重试。";
    }

    // 唯一约束冲突 (例如 votes 表的 UNIQUE(poll_id, user_id))
    if (code === "23505" || raw.includes("duplicate key")) {
      if (context === "vote") return "您已经投过票了，不能重复投票。";
      if (context === "register") return "该用户名或邮箱已被注册。";
      if (context === "admin-public-id") return "编号冲突，请重试。";
      return "数据已存在，无法重复提交。";
    }

    // 登录相关
    if (context === "login") {
      if (raw.includes("invalid login credentials")) {
        return "邮箱或密码不正确。";
      }
      if (raw.includes("email not confirmed")) {
        return "该邮箱尚未确认，请联系管理员。";
      }
      return "登录失败：" + (error.message || "未知错误");
    }

    // 注册相关
    if (context === "register") {
      if (raw.includes("already registered") || raw.includes("user already registered")) {
        return "该邮箱已被注册，请直接登录。";
      }
      if (raw.includes("password") && raw.includes("6")) {
        return "密码长度至少需要 6 位。";
      }
      if (raw.includes("invalid") && raw.includes("email")) {
        return "邮箱格式不正确。";
      }
      return "注册失败：" + (error.message || "未知错误");
    }

    // 权限相关 (RLS 拦截)
    if (raw.includes("row-level security") || raw.includes("permission denied") || code === "42501") {
      return "没有权限执行此操作。";
    }

    if (context === "vote") {
      return "投票失败：" + (error.message || "未知错误");
    }

    if (context === "verification") {
      const tokenMap = {
        NOT_AUTHENTICATED: "请先登录。",
        PROFILE_INCOMPLETE: "请先完善用户名、头像和 QQ 号。",
        ALREADY_PENDING: "您已经提交过申请，正在审核中。",
        ALREADY_VERIFIED: "您已经通过身份验证，无需重复申请。",
        REASON_TOO_SHORT: "申请理由太短，请再详细描述一下。",
        CHALLENGE_NOT_PASSED: "请先完成验证任务再提交申请。",
        CHALLENGE_NOT_FOUND: "验证任务不存在或已失效，请重新获取。",
        CHALLENGE_ALREADY_FINISHED: "该任务已经提交过了，请换一个新任务。",
        CHALLENGE_EXPIRED: "验证任务已过期，请重新获取。",
        NOT_PERMITTED: "没有权限执行此操作。",
        INVALID_ACTION: "无效的操作类型。",
        REQUEST_NOT_FOUND: "找不到对应的申请记录。",
      };
      const msg = (error.message || "").trim();
      if (tokenMap[msg]) return tokenMap[msg];
      return "操作失败：" + (error.message || "未知错误");
    }

    return error.message || "发生未知错误，请重试。";
  }

  function qs(name, url) {
    const params = new URL(url || window.location.href).searchParams;
    return params.get(name);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const VERIFICATION_STATUS_MAP = {
  unverified: { label: "未验证", cls: "badge--draft" },
  pending: { label: "审核中", cls: "badge--upcoming" },
  verified: { label: "已验证", cls: "badge--live" },
  rejected: { label: "被拒绝", cls: "badge--ended" },
  needs_more_info: { label: "需要补充资料", cls: "badge--upcoming" },
};
  function verificationStatusInfo(status) {
    return VERIFICATION_STATUS_MAP[status] || VERIFICATION_STATUS_MAP.unverified;
  }

  window.Utils = {
    formatDateTime,
    toDateTimeLocalValue,
    getPollStatus,
    friendlyError,
    qs,
    escapeHtml,
    verificationStatusInfo,
  };
})();
