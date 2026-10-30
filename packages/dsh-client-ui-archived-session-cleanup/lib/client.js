window.__ModuleLoader__.load({
  id: "@blake-r/dsh-client-ui-archived-session-cleanup",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var NS = "archived-session-cleanup";
    var ENDPOINT = "archivedSessionCleanup/";
    function callRemote(connection, method, args) {
      return connection.rpc.call("/api", ENDPOINT + method, { args: args }).then(function (result) {
        if (!result.ok) {
          var err = new Error(result.error && result.error.message ? result.error.message : "remote error");
          err.code = result.error && result.error.code ? result.error.code : "remote-error";
          throw err;
        }
        return result.value;
      });
    }
    function Section(props) {
      var getConnection = props.getConnection;
      var t = props.t;
      var connection = getConnection ? getConnection() : undefined;
      var canCall = !!(connection && connection.rpc && typeof connection.rpc.call === "function");
      var deleteOlderThan = function (days) { return callRemote(connection, "deleteOlderThan", { days: days }); };
      var previewOlderThan = function (days) { return callRemote(connection, "previewOlderThan", { days: days }); };
      var daysState = useState("14");
      var days = daysState[0];
      var setDays = daysState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var resultState = useState(null);
      var result = resultState[0];
      var setResult = resultState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var previewState = useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];
      var previewErrorState = useState(null);
      var previewError = previewErrorState[0];
      var setPreviewError = previewErrorState[1];

      // Live preview of what Delete would remove for the current days value.
      useEffect(function () {
        if (!canCall) {
          setPreview(null);
          setPreviewError(t("noConnection"));
          return;
        }
        var value = Number(days);
        if (!Number.isFinite(value) || value < 0) {
          setPreview(null);
          setPreviewError(t("invalidDays"));
          return;
        }
        var cancelled = false;
        var timer = setTimeout(function () {
          previewOlderThan(value).then(function (res) {
            if (!cancelled) {
              setPreview(res);
              setPreviewError(null);
            }
          }).catch(function (e) {
            if (!cancelled) {
              setPreview(null);
              setPreviewError(e && e.message ? e.message : String(e));
            }
          });
        }, 300);
        return function () {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [days, previewOlderThan, t]);

      var onDelete = useCallback(function () {
        if (!canCall) {
          setError(t("noConnection"));
          return;
        }
        var value = Number(days);
        if (!Number.isFinite(value) || value < 0) {
          setError(t("invalidDays"));
          return;
        }
        setBusy(true);
        setError(null);
        setResult(null);
        deleteOlderThan(value).then(function (res) {
          setResult(res);
        }).catch(function (e) {
          setError(e && e.message ? e.message : String(e));
        }).then(function () {
          setBusy(false);
        });
      }, [days, deleteOlderThan, t]);

      function renderBreakdown(list) {
        return list && list.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          h("div", { style: { fontWeight: 500, color: "var(--dsw-alias-label-primary)" } }, t("byWorkspace")),
          list.map(function (ws) {
            return h("div", { key: ws.id, style: { display: "flex", justifyContent: "space-between", gap: "16px" } },
              h("span", {}, ws.title),
              h("span", {}, String(ws.deleted))
            );
          })
        ) : null;
      }
      function noteLine(skipped) {
        return skipped > 0 ? h("div", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-warning-primary, var(--dsw-alias-label-secondary))" } }, t("skippedNote", { skipped: skipped })) : null;
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "20px", padding: "16px 0" } },
        h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
          h("label", { htmlFor: "asc-days", style: { fontSize: "14px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" } }, t("daysLabel")),
          h("div", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, t("daysDescription")),
          h("input", { id: "asc-days", type: "number", min: 0, step: 1, value: days, onChange: function (e) { setDays(e.target.value); }, style: { width: "140px", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-surface-primary)", color: "var(--dsw-alias-label-primary)", fontSize: "14px" } })
        ),
        preview ? h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } },
          h("div", {}, t("preview", { deleted: preview.deleted, total: preview.total })),
          noteLine(preview.skipped),
          renderBreakdown(preview.byWorkspace)
        ) : null,
        previewError ? h("div", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-danger-primary)" } }, previewError) : null,
        h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" } },
          h("button", { type: "button", disabled: busy, onClick: onDelete, style: { padding: "8px 16px", borderRadius: "6px", border: "none", background: "var(--dsw-alias-accent-primary)", color: "var(--dsw-alias-label-on-accent)", fontSize: "14px", lineHeight: "20px", cursor: "pointer" } }, busy ? t("deleting") : t("deleteButton")),
          result ? h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } },
            h("div", {}, t("result", { deleted: result.deleted, total: result.total })),
            noteLine(result.skipped),
            renderBreakdown(result.byWorkspace)
          ) : null,
          error ? h("div", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-danger-primary)" } }, error) : null
        )
      );
    }
    var inject = ["slots", "locale"];
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, {
          en: {
            nav: "Archived Sessions",
            daysLabel: "Delete archived sessions older than",
            daysDescription: "Sessions are permanently removed from disk. This cannot be undone.",
            deleteButton: "Delete",
            deleting: "Deleting…",
            invalidDays: "Enter a non-negative number of days.",
            noConnection: "Connection service unavailable.",
            preview: "Will delete {deleted} of {total} archived sessions.",
            result: "Deleted {deleted} of {total} archived sessions.",
            skippedNote: "{skipped} skipped — still open.",
            byWorkspace: "By workspace:"
          },
          zh: {
            nav: "归档会话",
            daysLabel: "删除早于",
            daysDescription: "会话将从磁盘永久删除，此操作不可撤销。",
            deleteButton: "删除",
            deleting: "删除中…",
            invalidDays: "请输入非负的天数。",
            noConnection: "连接服务不可用。",
            preview: "将删除 {total} 个归档会话中的 {deleted} 个。",
            result: "已删除 {total} 个归档会话中的 {deleted} 个。",
            skippedNote: "{skipped} 个被跳过——仍在打开。",
            byWorkspace: "按工作空间："
          }
        });
      }, "archived-session-cleanup: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "archived-session-cleanup",
          order: 90,
          label: function () { return t("nav"); },
          locale: NS,
          inject: function () {
            return {
              getConnection: function () {
                try {
                  return ctx.get("connection");
                } catch (e) {
                  return undefined;
                }
              }
            };
          }
        }, Section);
      });
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
