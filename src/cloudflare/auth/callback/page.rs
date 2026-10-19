use axum::response::Html;

pub(super) enum PageState {
    Received,
    Declined,
    Invalid,
    Finished,
}

pub(super) fn page(state: PageState, chinese: bool, detail: Option<&str>) -> Html<String> {
    let text = |english: &'static str, translated: &'static str| {
        if chinese { translated } else { english }
    };
    // Icons share the page's 24-unit stroke style.
    let (name, icon, title, message) = match state {
        PageState::Received => (
            "received",
            r#"<path d="m5.5 12.5 4 4 9-9"/>"#,
            text("Authorization complete", "授权成功"),
            text("Return to xrun to continue.", "回到 xrun 继续操作。"),
        ),
        PageState::Declined => (
            "declined",
            r#"<path d="m7.5 7.5 9 9m0-9-9 9"/>"#,
            text("Authorization not completed", "授权未完成"),
            text("Return to xrun to try again.", "回到 xrun 重新发起授权。"),
        ),
        PageState::Invalid => (
            "invalid",
            r#"<path d="M12 7v6m0 4v.01"/>"#,
            text("Invalid link", "链接无效"),
            text(
                "Start a new authorization from xrun.",
                "请从 xrun 重新发起授权。",
            ),
        ),
        PageState::Finished => (
            "finished",
            r#"<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/>"#,
            text("Authorization already finished", "授权已结束"),
            text("Return to xrun to see the result.", "回到 xrun 查看结果。"),
        ),
    };
    let details = detail.map_or_else(String::new, |detail| {
        format!(
            "<details><summary>{}</summary><pre>{}</pre></details>",
            text("Error details", "错误信息"),
            escape(detail)
        )
    });
    let logo = include_str!("../../../../assets/logos/xrun-wordmark-light.svg");
    let logo = logo.split_once("?>").map_or(logo, |(_, svg)| svg).trim();
    Html(
        include_str!("page.html")
            // The desktop's colors, radii and fonts, including its dark theme.
            .replace(
                "%%TOKENS%%",
                include_str!("../../../../desktop/src/styles/tokens.css"),
            )
            .replace("%%LANG%%", if chinese { "zh-CN" } else { "en" })
            .replace("%%STATE%%", name)
            .replace("%%ICON%%", icon)
            .replace("%%TITLE%%", title)
            .replace("%%MESSAGE%%", message)
            .replace(
                "%%FOOTER%%",
                text("You can close this page.", "可以关闭此页面。"),
            )
            .replace("%%BRAND%%", logo)
            // Provider text is inserted last so it cannot introduce template replacements.
            .replace("%%DETAILS%%", &details),
    )
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
