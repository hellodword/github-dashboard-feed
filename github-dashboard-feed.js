// ==UserScript==
// @name         GitHub Dashboard Feed
// @namespace    https://github.com/hellodword/github-dashboard-feed
// @homepageURL  https://github.com/hellodword/github-dashboard-feed
// @icon         https://github.com/favicon.ico
// @version      0.9.4
// @description  Show your GitHub received events as dashboard-style cards
// @author       hellodword
// @match        https://github.com/
// @match        https://github.com/dashboard
// @require      https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.3.1/purify.min.js
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @grant        GM.unregisterMenuCommand
// @grant        GM.notification
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/hellodword/github-dashboard-feed/refs/heads/master/github-dashboard-feed.userscript.js
// ==/UserScript==

/**
 * Entrypoint: main logic wrapped in an IIFE.
 */
(async function main() {
  // ================== REQUIRES ==================

  // ================== CONSTANTS ==================
  const FEED_SECTION_ID = "__gh-dashboard-feed-section__";
  const TOKEN_KEY = "github_token";
  const RENDER_BODY_KEY = "render_body_enabled";
  const ACTOR_FILTER_KEY = "actor_filter_enabled";
  const USE_SIDEBAR_KEY = "use_sidebar_enabled";
  const NOTIFICATION_MAX_LENGTH = 200;
  const PER_PAGE = 25;

  /**
   * Actor filter rules.
   * Each object may contain one or more of: id, login, display_login.
   * If an event's actor matches any property of any rule (===), the event will be filtered out if filtering is enabled.
   */
  const ACTOR_FILTER_LIST = [
    { login: "GitHub Enterprise", display_login: "GitHub Enterprise" },
    { id: 49699333, login: "dependabot[bot]" },
    {
      id: 27856297,
      login: "dependabot-preview[bot]",
      display_login: "dependabot-preview[bot]",
    },
    {
      id: 41898282,
      login: "github-actions[bot]",
      display_login: "github-actions[bot]",
    },
    { login: "GitHub Action", display_login: "actions-user" },
    { display_login: "dependabot support" },
    { login: "web-flow", display_login: "web-flow" },
  ];

  // ================== STATE VARIABLES ==================
  let renderBodyEnabled = false;
  let renderBodyMenuID = null;
  let actorFilterEnabled = true;
  let actorFilterMenuID = null;
  let useSidebarEnabled = false;
  let useSidebarMenuID = null;

  let md = null;

  /** Event list, paging info, and DOM references */
  let eventsList = [];
  let currentPage = 1;
  let hasMore = true;
  let loading = false;
  let containerRef = null;
  let moreBtnRef = null;

  // ================== UTILITY FUNCTIONS ==================

  /**
   * Initializes the Markdown engine if necessary.
   */
  function initMarkdown() {
    if (renderBodyEnabled && !md && window.markdownit) {
      md = window.markdownit({
        html: false, // Never allow raw HTML for security
        linkify: true,
        typographer: true,
        breaks: true,
        xhtmlOut: true,
      });
    }
  }

  /**
   * Rewrites the console to include a tag and send notifications.
   * All logs are forcibly visible and safe.
   */
  function rewriteConsole() {
    const TAG = "[GH Dashboard Feed]";

    // Preserve original console functions
    const original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    /**
     * Converts a string to visible ASCII for notification.
     * @param {string} str - Raw string
     * @returns {string} - ASCII-only string
     */
    function toVisibleAscii(str) {
      return String(str).replace(/[^\x20-\x7E]/g, "?");
    }

    /**
     * Formats arguments into a printable string.
     * @param {Array} args - Console arguments
     * @returns {string}
     */
    function formatArgs(args) {
      return args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (typeof arg === "undefined") return "undefined";
          if (arg === null) return "null";
          if (typeof arg === "object") {
            if (arg instanceof Error) return arg.stack || arg.toString();
            try {
              return JSON.stringify(arg);
            } catch {
              return "[object]";
            }
          }
          return String(arg);
        })
        .join(" ");
    }

    /**
     * Wraps a console function, adds a tag, and triggers notification.
     * @param {Function} fn - Original console function
     * @param {string} tag - Custom tag
     * @returns {Function}
     */
    function wrapConsole(fn, tag) {
      return function (...args) {
        try {
          fn(tag, ...args);
          const text = formatArgs([tag, ...args]);
          const asciiText = toVisibleAscii(text);
          GM.notification(
            asciiText.length > NOTIFICATION_MAX_LENGTH
              ? asciiText.slice(0, NOTIFICATION_MAX_LENGTH) + "..."
              : asciiText
          );
        } catch {
          // Ignore notification failures
        }
      };
    }

    console.log = wrapConsole(original.log, TAG);
    console.warn = wrapConsole(original.warn, TAG);
    console.error = wrapConsole(original.error, TAG);
  }

  /**
   * Updates or re-registers the "Render Body" menu command.
   */
  async function updateRenderBodyMenuCommand() {
    if (renderBodyMenuID !== null) {
      try {
        GM.unregisterMenuCommand(renderBodyMenuID);
      } catch (e) {
        // Ignore unregister failures
      }
    }

    renderBodyMenuID = GM.registerMenuCommand(
      `Turn ${renderBodyEnabled ? "Off" : "On"} Render Body Feature`,
      async () => {
        renderBodyEnabled = !renderBodyEnabled;
        initMarkdown();
        try {
          await GM.setValue(RENDER_BODY_KEY, renderBodyEnabled);
        } catch (e) {
          console.error("Failed to persist Render Body setting:", e);
        }
        console.log(
          `Render Body Feature is now ${renderBodyEnabled ? "On" : "Off"}`
        );
        await updateRenderBodyMenuCommand();
      },
      "t"
    );
  }

  /**
   * Updates or re-registers the "Actor Filter" menu command.
   */
  async function updateActorFilterMenuCommand() {
    if (actorFilterMenuID !== null) {
      try {
        GM.unregisterMenuCommand(actorFilterMenuID);
      } catch (e) {
        // Ignore unregister failures
      }
    }

    actorFilterMenuID = GM.registerMenuCommand(
      `Turn ${actorFilterEnabled ? "Off" : "On"} Actor Filter`,
      async () => {
        actorFilterEnabled = !actorFilterEnabled;
        try {
          await GM.setValue(ACTOR_FILTER_KEY, actorFilterEnabled);
        } catch (e) {
          console.error("Failed to persist Actor Filter setting:", e);
        }
        console.log(`Actor Filter is now ${actorFilterEnabled ? "On" : "Off"}`);
        await updateActorFilterMenuCommand();
      },
      "a"
    );
  }

  /**
   * Updates or re-registers the "Use Sidebar" menu command.
   */
  async function updateUseSidebarMenuCommand() {
    if (useSidebarMenuID !== null) {
      try {
        GM.unregisterMenuCommand(useSidebarMenuID);
      } catch (e) {
        // Ignore unregister failures
      }
    }

    useSidebarMenuID = GM.registerMenuCommand(
      `Render in ${useSidebarEnabled ? "middle" : "sidebar"}`,
      async () => {
        useSidebarEnabled = !useSidebarEnabled;
        try {
          await GM.setValue(USE_SIDEBAR_KEY, useSidebarEnabled);
        } catch (e) {
          console.error("Failed to persist Use Sidebar setting:", e);
        }
        console.log(`Rendering in ${useSidebarEnabled ? "sidebar" : "middle"}`);
        await updateUseSidebarMenuCommand();
      },
      "t"
    );
  }

  /**
   * Retrieves the GitHub personal access token from storage.
   * @returns {Promise<string|null>}
   */
  async function getToken() {
    try {
      const token = await GM.getValue(TOKEN_KEY, "");
      return typeof token === "string" && token.trim().length > 0
        ? token.trim()
        : null;
    } catch (e) {
      console.error("Error fetching token:", e);
      return null;
    }
  }

  /**
   * Prompts user to configure and store the GitHub token.
   */
  async function configureToken() {
    try {
      const currentVal = (await getToken()) || "";
      const val = window.prompt("GitHub Token", currentVal);
      if (val !== null) {
        await GM.setValue(TOKEN_KEY, val.trim());
      }
    } catch (e) {
      console.error("Configure token error:", e);
    }
  }

  /**
   * Attempts to extract the currently logged-in username from DOM.
   * @returns {string|null}
   */
  function getUsername() {
    try {
      const metaUserLogin = document.querySelector('meta[name="user-login"]');
      if (metaUserLogin?.content) return metaUserLogin.content;
      const metaActorLogin = document.querySelector(
        'meta[name="octolytics-actor-login"]'
      );
      if (metaActorLogin?.content) return metaActorLogin.content;
      const dataLogin = document.querySelector("[data-login]");
      if (dataLogin?.getAttribute("data-login"))
        return dataLogin.getAttribute("data-login");
    } catch (e) {
      console.error("Error detecting username:", e);
    }
    return null;
  }

  /**
   * Waits for username to be available in DOM.
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<string>}
   */
  function waitForUsername(timeout = 4000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const username = getUsername();
        if (username) return resolve(username);
        if (Date.now() - start > timeout)
          return reject(new Error("Timed out waiting for username"));
        setTimeout(poll, 350);
      })();
    });
  }

  /**
   * Waits for the right sidebar to appear.
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<Element>}
   */
  function waitForSidebar(timeout = 6000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        try {
          const sidebar = document.querySelector(".feed-right-sidebar");
          if (sidebar) return resolve(sidebar);
          if (Date.now() - start > timeout)
            return reject(
              new Error("Timed out waiting for feed-right-sidebar")
            );
          setTimeout(poll, 300);
        } catch (e) {
          reject(e);
        }
      })();
    });
  }

  /**
   * Waits for the middle feed-container to appear.
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<Element>}
   */
  function waitForFeedContainer(timeout = 6000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        try {
          const feedContainer = document.querySelector("feed-container");
          if (feedContainer) return resolve(feedContainer);
          if (Date.now() - start > timeout)
            return reject(new Error("Timed out waiting for feed-container"));
          setTimeout(poll, 300);
        } catch (e) {
          reject(e);
        }
      })();
    });
  }

  /**
   * Fetches received events from the GitHub API.
   * @param {string} username - GitHub username
   * @param {string} token    - GitHub Personal Access Token
   * @param {number} perPage  - Items per page
   * @param {number} page     - Page number
   * @returns {Promise<{events: Array, hasNext: boolean}>}
   */
  async function fetchReceivedEvents(username, token, perPage = 30, page = 1) {
    const url = `https://api.github.com/users/${encodeURIComponent(
      username
    )}/received_events?per_page=${perPage}&page=${page}`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (res.status === 401) {
        throw new Error("Token is invalid or expired");
      }
      if (!res.ok) {
        throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
      }
      const link = res.headers.get("Link");
      let hasNext = false;
      if (link) {
        hasNext = /rel="next"/.test(link);
      }
      const events = await res.json();
      if (!Array.isArray(events)) {
        throw new Error("Unexpected GitHub API response: not an array");
      }
      return { events, hasNext };
    } catch (error) {
      console.error("Fetch error:", error);
      throw error;
    }
  }

  /**
   * Removes the old section node by ID.
   * @param {string} sectionId
   */
  function removeOldSection(sectionId = FEED_SECTION_ID) {
    try {
      const old = document.getElementById(sectionId);
      if (old && old.parentElement) old.parentElement.removeChild(old);
    } catch (e) {
      // Ignore removal failures
    }
  }

  /**
   * Inserts the events section into the parent, replacing any older section.
   * @param {Element} cardsWrapper
   * @param {Element} parent
   * @param {string} sectionId
   */
  function insertEventsSectionSibling(
    cardsWrapper,
    parent,
    sectionId = FEED_SECTION_ID
  ) {
    removeOldSection(sectionId);
    cardsWrapper.id = sectionId;
    try {
      if (parent.firstChild) {
        parent.insertBefore(cardsWrapper, parent.firstChild);
      } else {
        parent.appendChild(cardsWrapper);
      }
    } catch (e) {
      console.error("Failed to insert events section:", e);
    }
  }

  /**
   * Formats a date string as a "time ago" label.
   * @param {string} dateString
   * @returns {string}
   */
  function timeAgo(dateString) {
    if (!dateString) return "";
    const now = new Date();
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return "";
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 10) return "now";
    if (seconds < 60) return `${seconds} seconds ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 2) return "a minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 2) return "an hour ago";
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    if (days < 2) return "a day ago";
    if (days < 7) return `${days} days ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 2) return "a week ago";
    return `${weeks} weeks ago`;
  }

  /**
   * Renders a reactions bar if reactions exist on the target object.
   * @param {object} reactions - Reactions object from GitHub API
   * @returns {HTMLElement|null}
   */
  function renderReactionsBar(reactions) {
    if (!reactions || typeof reactions !== "object") return null;
    const reactionMeta = [
      { key: "+1", emoji: "👍", label: "Thumbs up" },
      { key: "-1", emoji: "👎", label: "Thumbs down" },
      { key: "laugh", emoji: "😄", label: "Laugh" },
      { key: "hooray", emoji: "🎉", label: "Hooray" },
      { key: "confused", emoji: "😕", label: "Confused" },
      { key: "heart", emoji: "❤️", label: "Heart" },
      { key: "rocket", emoji: "🚀", label: "Rocket" },
      { key: "eyes", emoji: "👀", label: "Eyes" },
    ];
    let hasAny = false;
    for (const meta of reactionMeta) {
      if (typeof reactions[meta.key] === "number" && reactions[meta.key] > 0) {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) return null;

    // Styling similar to GitHub's reactions bar
    const bar = document.createElement("div");
    bar.className = "gh-dashboard-reactions-bar";
    bar.style.display = "flex";
    bar.style.flexWrap = "wrap";
    bar.style.gap = "4px";
    bar.style.margin = "4px 0 0 35px";
    bar.style.alignItems = "center";
    for (const meta of reactionMeta) {
      const count = reactions[meta.key];
      if (typeof count === "number" && count > 0) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.disabled = true;
        btn.className = "btn btn-sm btn-reaction";
        btn.setAttribute("aria-label", `${count} ${meta.label}`);
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.background = "#f6f8fa";
        btn.style.border = "1px solid #d0d7de";
        btn.style.borderRadius = "16px";
        btn.style.fontSize = "13px";
        btn.style.padding = "2px 7px";
        btn.style.color = "#57606a";
        btn.style.cursor = "not-allowed";
        btn.innerHTML = `<span style="font-size:15px;line-height:1">${meta.emoji}</span> <span style="margin-left:2px">${count}</span>`;
        bar.appendChild(btn);
      }
    }
    return bar;
  }

  /**
   * Determines whether the given actor matches any filter rule.
   * @param {object} actor - The event's actor object
   * @returns {boolean}
   */
  function isActorFiltered(actor) {
    if (!actor) return false;
    for (const rule of ACTOR_FILTER_LIST) {
      for (const key of Object.keys(rule)) {
        if (actor[key] === rule[key]) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Renders an event card element.
   * @param {object} event - GitHub event object
   * @returns {Promise<HTMLElement>}
   */
  async function renderEventCard(event) {
    const { type, repo, actor, created_at, payload } = event || {};
    const card = document.createElement("div");

    card.className =
      "dashboard-events color-bg-default border color-border-default p-3 rounded-2";
    if (!useSidebarEnabled) {
      card.className += " feed-item-content width-full height-fit";
    } else {
      card.style.flex = "1 1 320px";
      card.style.minWidth = "260px";
      card.style.maxWidth = "420px";
    }

    card.style.margin = "0 8px 8px 0";
    card.style.boxSizing = "border-box";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.justifyContent = "space-between";
    card.style.height = "auto";
    card.style.overflow = "hidden";

    // Actor and repo rendering
    const actorLink =
      actor && actor.login
        ? `<a style="font-weight:bold" href="https://github.com/${encodeURIComponent(
            actor.login
          )}" target="_blank" rel="noopener noreferrer">${actor.login}</a>`
        : "";
    const actorAvatar =
      actor && actor.avatar_url
        ? `<img src="${actor.avatar_url}" alt="avatar" style="width:28px;height:28px;border-radius:50%;margin-right:7px;vertical-align:middle;">`
        : "";
    const repoLink =
      repo && repo.name
        ? `<a style="font-weight:bold" href="https://github.com/${repo.name}" target="_blank" rel="noopener noreferrer">${repo.name}</a>`
        : "";

    /**
     * Renders body or short_description_html, always sanitized.
     * @param {string} body - Markdown content
     * @param {string|null} html - HTML content
     * @returns {string}
     */
    function renderBodyOrShortHtml(body, html) {
      if (!renderBodyEnabled) return "";
      let htmlContent = `<div style="max-width:340px;margin-left:35px;overflow-wrap:break-word;">${
        html
          ? `<div class="event-body-html">${DOMPurify.sanitize(html)}</div>`
          : body && md
          ? `<div class="event-body-md">${DOMPurify.sanitize(
              md.render(body)
            )}</div>`
          : ""
      }</div>`;
      return htmlContent;
    }

    /**
     * Main content rendering based on event type.
     */
    let content = "";
    try {
      switch (type) {
        case "WatchEvent":
          content = `${actorAvatar}${actorLink} ${
            payload?.action === "started" ? "starred" : payload?.action || "did"
          } ${repoLink}`;
          break;

        case "ForkEvent":
          content = `${actorAvatar}${actorLink} forked <a href="${
            payload?.forkee?.html_url || "#"
          }" target="_blank" rel="noopener noreferrer">${DOMPurify.sanitize(
            payload?.forkee?.full_name || ""
          )}</a> from ${repoLink}`;
          break;

        case "PushEvent":
          {
            const commits = payload?.commits || [];
            content = `${actorAvatar}${actorLink} pushed <a href="https://github.com/${
              repo?.name || ""
            }/compare/${payload?.before || ""}...${
              payload?.head || ""
            }" target="_blank" rel="noopener noreferrer">${
              (payload?.size || 0) === 0
                ? "something"
                : `${payload?.size} ${
                    payload?.size === 1 ? "commit" : "commits"
                  }`
            }</a> to ${repoLink}`;

            if (commits.length > 0) {
              let list = [];
              for (const commit of commits.slice(0, 9)) {
                const messages = (commit.message || "").split("\n");
                const message =
                  messages.length === 0
                    ? ""
                    : messages.length === 1
                    ? messages[0]
                    : messages[0] + " ...";
                list.push(
                  `- **[${
                    commit.sha?.substring(0, 7) || "?"
                  }](https://github.com/${repo?.name || ""}/commit/${
                    commit.sha
                  })**: ${message}`
                );
              }
              content += renderBodyOrShortHtml(list.join("\n"), null);
            }
          }
          break;

        case "CreateEvent":
          if (payload?.ref_type === "repository") {
            content = `${actorAvatar}${actorLink} created repository ${repoLink}`;
          } else {
            content = `${actorAvatar}${actorLink} created ${
              payload?.ref_type || ""
            } <strong>${DOMPurify.sanitize(
              payload?.ref || ""
            )}</strong> in ${repoLink}`;
          }
          break;

        case "DeleteEvent":
          content = `${actorAvatar}${actorLink} deleted ${
            payload?.ref_type || ""
          } <strong>${DOMPurify.sanitize(
            payload?.ref || ""
          )}</strong> in ${repoLink}`;
          break;

        case "PublicEvent":
          content = `${actorAvatar}${actorLink} open sourced ${repoLink}`;
          break;

        case "IssueCommentEvent":
          content = `${actorAvatar}${actorLink} commented on 
                      <a href="${
                        payload?.comment?.html_url || "#"
                      }" target="_blank" rel="noopener noreferrer">issue #${
            payload?.issue?.number || "?"
          }</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(payload?.comment?.body, null);
          if (payload?.comment?.reactions) {
            const bar = renderReactionsBar(payload.comment.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "IssuesEvent":
          content = `${actorAvatar}${actorLink} ${payload?.action || "did"}
                    <a href="${
                      payload?.issue?.html_url || "#"
                    }" target="_blank" rel="noopener noreferrer">issue #${
            payload?.issue?.number || "?"
          }</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(
            `##### ${payload?.issue?.title || ""}`,
            null
          );
          if (payload?.issue?.reactions) {
            const bar = renderReactionsBar(payload.issue.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "PullRequestEvent":
          content = `${actorAvatar}${actorLink} ${payload?.action || "did"} 
                    <a href="${
                      payload?.pull_request?.html_url || "#"
                    }" target="_blank" rel="noopener noreferrer">pull request #${
            payload?.pull_request?.number || "?"
          }</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(
            `##### ${payload?.pull_request?.title || ""}\n${
              payload?.pull_request?.body || ""
            }`,
            null
          );
          if (payload?.pull_request?.reactions) {
            const bar = renderReactionsBar(payload.pull_request.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "PullRequestReviewEvent":
          content = `${actorAvatar}${actorLink} reviewed 
                    <a href="${
                      payload?.review?.html_url || "#"
                    }" target="_blank" rel="noopener noreferrer">pull request #${
            payload?.pull_request?.number || "?"
          }</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(
            `##### ${payload?.pull_request?.title || ""}\n${
              payload?.review?.body || ""
            }`,
            null
          );
          if (payload?.review?.reactions) {
            const bar = renderReactionsBar(payload.review.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "PullRequestReviewCommentEvent":
          content = `${actorAvatar}${actorLink} commented on 
                    <a href="${
                      payload?.comment?.html_url || "#"
                    }" target="_blank" rel="noopener noreferrer">pull request #${
            payload?.pull_request?.number || "?"
          }</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(
            `##### ${payload?.pull_request?.title || ""}\n${
              payload?.comment?.body || ""
            }`,
            null
          );
          if (payload?.comment?.reactions) {
            const bar = renderReactionsBar(payload.comment.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "CommitCommentEvent":
          content = `${actorAvatar}${actorLink} commented on 
                    <a href="${
                      payload?.comment?.html_url || "#"
                    }" target="_blank" rel="noopener noreferrer">commit ${
            payload?.comment?.commit_id?.substring(0, 7) || "???"
          }</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(payload?.comment?.body, null);
          if (payload?.comment?.reactions) {
            const bar = renderReactionsBar(payload.comment.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "MemberEvent":
          content = `${actorAvatar}${actorLink} added <a href="https://github.com/${encodeURIComponent(
            payload?.member?.login || ""
          )}" target="_blank" rel="noopener noreferrer">${DOMPurify.sanitize(
            payload?.member?.login || ""
          )}</a> to ${repoLink}`;
          break;

        case "GollumEvent":
          content = `${actorAvatar}${actorLink} edited wiki in ${repoLink}`;
          {
            const pages = payload?.pages || [];
            if (pages.length > 0) {
              let list = [];
              for (const page of pages.slice(0, 9)) {
                list.push(
                  `- ${page.action} [${page.page_name}](${page.html_url})`
                );
              }
              content += renderBodyOrShortHtml(list.join("\n"), null);
            }
          }
          break;

        case "ReleaseEvent":
          content = `${actorAvatar}${actorLink} ${payload?.action || "did"} 
                  <a href="${
                    payload?.release?.html_url || "#"
                  }" target="_blank" rel="noopener noreferrer">release ${DOMPurify.sanitize(
            payload?.release?.name || payload?.release?.tag_name || ""
          )}</a> in ${repoLink}`;
          content += renderBodyOrShortHtml(payload?.release?.body, null);
          if (payload?.release?.reactions) {
            const bar = renderReactionsBar(payload.release.reactions);
            if (bar) content += bar.outerHTML;
          }
          break;

        case "SponsorshipEvent":
          content = `${actorAvatar}${actorLink} sponsored or received a sponsorship.`;
          break;

        default:
          content = `${actorAvatar}${actorLink} did <code>${DOMPurify.sanitize(
            type || ""
          )}</code> in ${repoLink}`;
      }
    } catch (e) {
      content =
        actorAvatar +
        actorLink +
        " [Render error] " +
        (repoLink || "") +
        " " +
        DOMPurify.sanitize(type || "");
      console.error("Error rendering card for event:", e, event);
    }

    // Date formatting
    const date = timeAgo(created_at);

    // Card rendering
    try {
      card.innerHTML = DOMPurify.sanitize(
        `<div>${content}</div>
        <div style="margin-top:7px;color:gray;font-size:85%">${date}</div>`
      );
    } catch (e) {
      card.innerHTML = "<div style='color:red'>[Error rendering card]</div>";
      console.error("Card innerHTML error:", e);
    }
    return card;
  }

  /**
   * Renders the events feed section, appending new events.
   * @param {boolean} append - Whether to append to existing events
   * @param {string} username
   * @param {string} token
   * @param {Element} parent
   */
  async function renderFeed(append = false, username, token, parent) {
    let cardsSection;
    if (containerRef && append) {
      cardsSection = containerRef;
    } else {
      cardsSection = document.createElement("div");
      cardsSection.style.display = "flex";
      cardsSection.style.flexDirection = "column";
      cardsSection.style.margin = "0 0 19px 0";
      cardsSection.style.gap = "0 2px";
      cardsSection.style.minHeight = "420px";
      cardsSection.id = FEED_SECTION_ID;
      containerRef = cardsSection;
    }

    // Header
    let header = cardsSection.querySelector(".gh-dashboard-feed-header");
    if (!header) {
      header = document.createElement("div");
      header.className = "gh-dashboard-feed-header";
      header.style.display = "flex";
      header.style.justifyContent = "flex-start";
      header.style.alignItems = "baseline";
      header.innerHTML = `<h3 style="font-size:18px;font-weight:600;margin:0 5px 16px 0">Your Received Events</h3>`;
      cardsSection.append(header);
    }

    // Cards row
    let cardsRow = cardsSection.querySelector(".gh-dashboard-feed-row");
    if (!cardsRow) {
      cardsRow = document.createElement("div");
      cardsRow.className = "gh-dashboard-feed-row";
      cardsRow.style.display = "flex";
      cardsRow.style.flexWrap = "wrap";
      cardsRow.style.gap = "0 2px";
      cardsRow.style.width = "100%";
      cardsRow.style.boxSizing = "border-box";
      cardsRow.style.minHeight = "330px";
      cardsSection.append(cardsRow);
    }

    // If not appending, clear all event cards
    if (!append) {
      cardsRow.innerHTML = "";
    }

    // Insert section into parent
    if (!append) {
      insertEventsSectionSibling(cardsSection, parent, FEED_SECTION_ID);
    } else if (!parent.contains(cardsSection)) {
      try {
        parent.insertBefore(cardsSection, parent.firstChild);
      } catch (e) {
        console.error("parent element append error:", e);
      }
    }

    // Render event cards
    if (eventsList.length === 0 && !loading) {
      cardsRow.innerHTML =
        '<div style="color:#888;padding:12px">No events</div>';
    } else {
      // Only render new cards if appending
      const fragment = document.createDocumentFragment();
      for (let i = cardsRow.childNodes.length; i < eventsList.length; ++i) {
        try {
          fragment.appendChild(await renderEventCard(eventsList[i]));
        } catch (e) {
          console.error("Error appending event card:", e, eventsList[i]);
        }
      }
      cardsRow.appendChild(fragment);
    }

    // --- More Button Handling ---
    if (eventsList.length === 0 || !hasMore) {
      if (moreBtnRef && moreBtnRef.parentElement) {
        moreBtnRef.parentElement.removeChild(moreBtnRef);
      }
      moreBtnRef = null;
    } else {
      if (!moreBtnRef) {
        moreBtnRef = document.createElement("div");
        moreBtnRef.style.display = "flex";
        moreBtnRef.style.justifyContent = "center";
        moreBtnRef.style.margin = "4px 0 0 0";
        moreBtnRef.style.width = "100%";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-outline btn-block gh-dashboard-feed-more-btn";
        btn.style.fontWeight = "500";
        btn.style.marginTop = "0";
        btn.onclick = async () => {
          if (loading) return;
          loading = true;
          renderFeed(true, username, token, parent);
          let prevHeight = cardsSection.scrollHeight;
          let prevScroll = window.scrollY;
          try {
            const nextPage = currentPage + 1;
            const data = await fetchReceivedEvents(
              username,
              token,
              PER_PAGE,
              nextPage
            );
            let newEvents = Array.isArray(data.events) ? data.events : [];
            if (actorFilterEnabled) {
              newEvents = newEvents.filter((ev) => !isActorFiltered(ev.actor));
            }
            eventsList = eventsList.concat(newEvents);
            currentPage = nextPage;
            hasMore = !!data.hasNext && newEvents.length > 0;
          } catch (e) {
            hasMore = false;
            console.error("Load more error:", e);
          }
          loading = false;
          renderFeed(true, username, token, parent);

          // Maintain scroll position if user is not at the bottom
          if (window.scrollY < prevHeight - 200) {
            window.scrollTo({ top: prevScroll, behavior: "auto" });
          }
        };
        moreBtnRef.appendChild(btn);
        cardsSection.appendChild(moreBtnRef);
      }
      const btn = moreBtnRef.querySelector("button");
      if (loading) {
        btn.disabled = true;
        btn.textContent = "Loading More...";
      } else {
        btn.disabled = false;
        btn.textContent = "More";
      }
      // Ensure button is at the end
      if (cardsSection.lastChild !== moreBtnRef) {
        cardsSection.appendChild(moreBtnRef);
      }
    }
  }

  /**
   * Fetches the first page and renders the feed.
   * @param {string} username
   * @param {string} token
   * @param {Element} parent
   */
  async function initialLoad(username, token, parent) {
    loading = true;
    await renderFeed(false, username, token, parent); // Show Loading
    try {
      const data = await fetchReceivedEvents(username, token, PER_PAGE, 1);
      let events = Array.isArray(data.events) ? data.events : [];
      if (actorFilterEnabled) {
        events = events.filter((ev) => !isActorFiltered(ev.actor));
      }
      eventsList = events;
      currentPage = 1;
      hasMore = !!data.hasNext && events.length > 0;
    } catch (e) {
      eventsList = [];
      currentPage = 1;
      hasMore = false;
      console.error("initialLoad error:", e);
    }
    loading = false;
    await renderFeed(false, username, token, parent);
  }

  // ================== MAIN ENTRYPOINT ==================
  try {
    // Step 1: Setup state and menu
    rewriteConsole();
    try {
      renderBodyEnabled = await GM.getValue(RENDER_BODY_KEY, false);
    } catch {
      renderBodyEnabled = false;
    }
    try {
      actorFilterEnabled = await GM.getValue(ACTOR_FILTER_KEY, true);
    } catch {
      actorFilterEnabled = true;
    }
    try {
      useSidebarEnabled = await GM.getValue(USE_SIDEBAR_KEY, false);
    } catch {
      useSidebarEnabled = true;
    }
    initMarkdown();

    GM.registerMenuCommand("Configure GitHub Token", configureToken);
    await updateRenderBodyMenuCommand();
    await updateActorFilterMenuCommand();
    await updateUseSidebarMenuCommand();

    // Step 2: Get token
    const token = await getToken();
    if (!token) {
      console.warn("No token configured, skipping.");
      return;
    }

    // Step 3: Wait for username and sidebar
    let username, sidebar, feedContainer;
    try {
      [username, sidebar, feedContainer] = await Promise.all([
        waitForUsername(),
        waitForSidebar(),
        waitForFeedContainer(),
      ]);
    } catch (e) {
      console.error("Failed to detect username or components:", e);
      return;
    }
    if (!username) {
      console.warn("Could not find username, skipping.");
      return;
    }
    if (!sidebar) {
      console.warn("Could not find sidebar, skipping.");
      return;
    }
    if (!feedContainer) {
      console.warn("Could not find feed-container, skipping.");
      return;
    }

    let parent;
    if (useSidebarEnabled) {
      parent = sidebar;
    } else {
      feedContainer.innerHTML = "";
      parent = feedContainer;
    }

    await initialLoad(username, token, parent);
  } catch (e) {
    console.error("Unexpected failure:", e);
  }
})();
