// ==UserScript==
// @name         GitHub Dashboard Feed
// @namespace    https://github.com/hellodword/github-dashboard-feed
// @homepageURL  https://github.com/hellodword/github-dashboard-feed
// @icon         https://github.com/favicon.ico
// @version      0.7.2
// @description  Show your GitHub received events as dashboard-style cards
// @author       hellodword
// @match        https://github.com/
// @match        https://github.com/dashboard
// @require      https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.7/purify.min.js
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @grant        GM.unregisterMenuCommand
// @grant        GM.notification
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/hellodword/github-dashboard-feed/refs/heads/master/github-dashboard-feed.userscript.js
// ==/UserScript==

/**
 * Entrypoint: main logic wrapped in IIFE.
 */
(async function main() {
  // Constants
  const FEED_SECTION_ID = "__gh-dashboard-feed-section__";
  const TOKEN_KEY = "github_token";
  const RENDER_BODY_KEY = "render_body";
  const PAGINATION_MAX_DISPLAY = 6;
  const NOTIFICATION_MAX_LENGTH = 200;

  // State
  let shouldRenderBody = false;
  let shouldRenderBodyMenuID = null;
  let md = null;

  /**
   * Initialize markdown engine if needed.
   */
  function initMarkdown() {
    if (shouldRenderBody && !md) {
      md = window.markdownit({
        html: false, // Strictly disallow raw HTML for safety
        linkify: true,
        typographer: true,
        breaks: true,
        xhtmlOut: true,
      });
    }
  }

  /**
   * Rewrite console to include tag and send notifications.
   * All logs are forced visible and safe.
   */
  function rewriteConsole() {
    const TAG = "[GH Dashboard Feed]";

    // Capture originals
    const original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    /**
     * Convert string to visible ASCII for notification.
     */
    function toVisibleAscii(str) {
      return str.replace(/[^\x20-\x7E]/g, "?");
    }

    /**
     * Convert arguments to a safe, printable string.
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
     * Wrap a console function to add tag, and trigger notification.
     */
    function wrapConsole(fn, tag) {
      return function (...args) {
        fn(tag, ...args);
        try {
          const text = formatArgs([tag, ...args]);
          const asciiText = toVisibleAscii(text);
          GM.notification(
            asciiText.length > NOTIFICATION_MAX_LENGTH
              ? asciiText.slice(0, NOTIFICATION_MAX_LENGTH) + "..."
              : asciiText
          );
        } catch {} // Ignore notification failures
      };
    }

    console.log = wrapConsole(original.log, TAG);
    console.warn = wrapConsole(original.warn, TAG);
    console.error = wrapConsole(original.error, TAG);
  }

  /**
   * Update or re-register the "Render Body" menu command.
   */
  async function updateRenderBodyMenuCommand() {
    if (shouldRenderBodyMenuID !== null)
      GM.unregisterMenuCommand(shouldRenderBodyMenuID);

    shouldRenderBodyMenuID = GM.registerMenuCommand(
      `Turn ${shouldRenderBody ? "Off" : "On"} Render Body Feature`,
      async () => {
        shouldRenderBody = !shouldRenderBody;
        initMarkdown();
        await GM.setValue(RENDER_BODY_KEY, shouldRenderBody);
        console.log(
          `Render Body Feature is now ${shouldRenderBody ? "On" : "Off"}`
        );
        await updateRenderBodyMenuCommand();
      },
      "t"
    );
  }

  /**
   * Get GitHub personal access token from storage.
   */
  async function getToken() {
    try {
      const token = await GM.getValue(TOKEN_KEY, "");
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch (e) {
      console.error("Error fetching token:", e);
      return null;
    }
  }

  /**
   * Prompt user and store GitHub token.
   */
  async function configureToken() {
    try {
      const val = prompt("GitHub Token", (await getToken()) || "");
      if (val !== null) {
        await GM.setValue(TOKEN_KEY, val.trim());
      }
    } catch (e) {
      console.error("Configure token error:", e);
    }
  }

  /**
   * Try to get currently logged-in username from DOM.
   */
  function getUsername() {
    try {
      // Try meta tags and data-login attributes
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
   * Wait for username to be available in DOM.
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
   * Wait for the right sidebar to appear.
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
   * Fetch received events from GitHub API.
   * @param {string} username - GitHub username
   * @param {string} token    - GitHub Personal Access Token
   * @param {number} perPage  - Items per page
   * @param {number} page     - Page number
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
      let hasNext = false,
        lastPage = page;
      if (link) {
        hasNext = /rel="next"/.test(link);
        const m = link.match(/&page=(\d+)>; rel="last"/);
        if (m) lastPage = parseInt(m[1], 10);
        else lastPage = hasNext ? page + 1 : page;
      }
      return { events: await res.json(), lastPage };
    } catch (error) {
      console.error("Fetch error:", error);
      throw error;
    }
  }

  /**
   * Remove old section node by ID.
   */
  function removeOldSection(sectionId = FEED_SECTION_ID) {
    try {
      const old = document.getElementById(sectionId);
      if (old && old.parentElement) old.parentElement.removeChild(old);
    } catch {}
  }

  /**
   * Insert events section into sidebar, replacing older one.
   */
  function insertEventsSectionSibling(
    cardsWrapper,
    sidebar,
    sectionId = FEED_SECTION_ID
  ) {
    removeOldSection(sectionId);
    cardsWrapper.id = sectionId;
    if (sidebar.firstChild) {
      sidebar.insertBefore(cardsWrapper, sidebar.firstChild);
    } else {
      sidebar.appendChild(cardsWrapper);
    }
  }

  /**
   * Generate array for pagination display.
   */
  function getPaginationDisplay(page, lastPage) {
    if (lastPage <= PAGINATION_MAX_DISPLAY) {
      return Array.from({ length: lastPage }, (_, i) => i + 1);
    }
    if (page <= 3) {
      return [1, 2, 3, 4, "...", lastPage - 1, lastPage];
    }
    if (page === 4) {
      return [1, 2, 3, 4, 5, "...", lastPage];
    }
    if (page >= lastPage - 2) {
      return [1, 2, "...", lastPage - 3, lastPage - 2, lastPage - 1, lastPage];
    }
    if (page === lastPage - 3) {
      return [
        1,
        2,
        "...",
        lastPage - 4,
        lastPage - 3,
        lastPage - 2,
        lastPage - 1,
        lastPage,
      ];
    }
    return [1, "...", page - 1, page, page + 1, "...", lastPage];
  }

  /**
   * Render pagination controls with numbers and ellipsis.
   */
  function renderPaginationControls({
    page,
    lastPage,
    onPageChange,
    containerId,
  }) {
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Pagination");
    nav.style.display = "flex";
    nav.style.justifyContent = "center";
    nav.style.margin = "16px 0 0 0";

    const ul = document.createElement("ul");
    ul.className = "pagination";
    ul.style.display = "inline-flex";
    ul.style.listStyle = "none";
    ul.style.padding = "0";
    ul.style.margin = "0";

    function addBtn(txt, pageNum, isActive, isDisabled) {
      const li = document.createElement("li");
      if (txt === "...") {
        li.innerHTML = `<span style="display:inline-block;min-width:24px;text-align:center;color:#888;">...</span>`;
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = txt;
        btn.className = "btn btn-outline BtnGroup-item";
        btn.disabled = !!isDisabled;
        btn.style.margin = "0 2px";
        btn.style.fontSize = "13px";
        btn.style.minWidth = "32px";
        btn.style.padding = "5px 10px";
        btn.style.cursor = isDisabled ? "not-allowed" : "pointer";
        if (isActive) {
          btn.className += " selected";
          btn.style.fontWeight = "bold";
          btn.style.background = "#ddf4ff";
        }
        btn.onclick = () => {
          if (!isDisabled && pageNum !== page) {
            onPageChange(pageNum);
            setTimeout(() => {
              const el = document.getElementById(containerId);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 20);
          }
        };
        li.appendChild(btn);
      }
      ul.appendChild(li);
    }
    const displayPages = getPaginationDisplay(page, lastPage);
    displayPages.forEach((p) => {
      if (p === "...") {
        addBtn("...", 0, false, true);
      } else {
        addBtn(`${p}`, p, p === page, false);
      }
    });
    nav.appendChild(ul);
    return nav;
  }

  /**
   * Format a date string as a "time ago" label.
   */
  function timeAgo(dateString) {
    const now = new Date();
    const date = new Date(dateString);
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
   * Render an event card element.
   * @param {object} event - GitHub event object
   */
  async function renderEventCard(event) {
    const { type, repo, actor, created_at, payload } = event;
    const card = document.createElement("div");
    card.className =
      "dashboard-events color-bg-default border color-border-default p-3 rounded-2";
    card.style.flex = "1 1 320px";
    card.style.minWidth = "260px";
    card.style.maxWidth = "420px";
    card.style.margin = "0 8px 8px 0";
    card.style.boxSizing = "border-box";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.justifyContent = "space-between";
    card.style.height = "auto";
    card.style.overflow = "hidden";

    // Actor and repo visualization
    const actorLink = actor
      ? `<a style="font-weight:bold" href="https://github.com/${encodeURIComponent(
          actor.login
        )}" target="_blank" rel="noopener noreferrer">${actor.login}</a>`
      : "";
    const actorAvatar = actor
      ? `<img src="${actor.avatar_url}" alt="avatar" style="width:28px;height:28px;border-radius:50%;margin-right:7px;vertical-align:middle;">`
      : "";
    const repoLink = repo
      ? `<a style="font-weight:bold" href="https://github.com/${encodeURIComponent(
          repo.name
        )}" target="_blank" rel="noopener noreferrer">${repo.name}</a>`
      : "";

    /**
     * Render body or short_description_html.
     * Always sanitize HTML with DOMPurify.
     */
    function renderBodyOrShortHtml(body, html) {
      return `<div style="max-width:340px;margin-left:35px;overflow-wrap:break-word;">${
        html
          ? `<div class="event-body-html">${DOMPurify.sanitize(html)}</div>`
          : body && md
          ? `<div class="event-body-md">${DOMPurify.sanitize(
              md.render(body)
            )}</div>`
          : ""
      }</div>`;
    }

    /**
     * Compose the main content for the event card based on event type.
     */
    let content = "";
    try {
      switch (type) {
        case "WatchEvent":
          content = `${actorAvatar}${actorLink} ${
            payload.action === "started" ? "starred" : payload.action
          } ${repoLink}`;
          break;
        case "ForkEvent":
          content = `${actorAvatar}${actorLink} forked <a href="${
            payload.forkee.html_url
          }" target="_blank" rel="noopener noreferrer">${DOMPurify.sanitize(
            payload.forkee.full_name
          )}</a> from ${repoLink}`;
          break;
        case "PushEvent": {
          const commits = payload.commits || [];
          content = `${actorAvatar}${actorLink} pushed <a href="https://github.com/${encodeURIComponent(
            repo.name
          )}/compare/${payload.before}...${
            payload.head
          }" target="_blank" rel="noopener noreferrer">${payload.size} ${
            payload.size > 1 ? "commits" : "commit"
          }</a> to ${repoLink}`;
          if (shouldRenderBody && commits.length > 0 && md) {
            content += `<ul style="margin-top:3px;max-width:340px;margin-left:35px;overflow-wrap:break-word;">${commits
              .slice(0, 3)
              .map(
                (commit) =>
                  `<li style="font-size:90%">${DOMPurify.sanitize(
                    md.renderInline(commit.message)
                  )}<span style="color:gray"> (${DOMPurify.sanitize(
                    commit.author?.name || ""
                  )})</span></li>`
              )
              .join("")}</ul>`;
          }
          break;
        }
        case "CreateEvent":
          if (payload.ref_type === "repository") {
            content = `${actorAvatar}${actorLink} created repository ${repoLink}`;
          } else {
            content = `${actorAvatar}${actorLink} created ${
              payload.ref_type
            } <strong>${DOMPurify.sanitize(
              payload.ref || ""
            )}</strong> in ${repoLink}`;
          }
          break;
        case "DeleteEvent":
          content = `${actorAvatar}${actorLink} deleted ${
            payload.ref_type
          } <strong>${DOMPurify.sanitize(payload.ref)}</strong> in ${repoLink}`;
          break;
        case "PublicEvent":
          content = `${actorAvatar}${actorLink} open sourced ${repoLink}`;
          break;
        case "IssueCommentEvent":
          if (payload.issue) {
            content = `${actorAvatar}${actorLink} commented on 
                      <a href="${payload.issue.html_url}" target="_blank" rel="noopener noreferrer">issue #${payload.issue.number}</a> in ${repoLink}`;
            if (shouldRenderBody && payload.comment)
              content += renderBodyOrShortHtml(
                payload.comment.body,
                payload.comment.short_description_html
              );
          }
          break;
        case "IssuesEvent":
          if (payload.issue) {
            content = `${actorAvatar}${actorLink} ${payload.action} issue
                    <a href="${payload.issue.html_url}" target="_blank" rel="noopener noreferrer">#${payload.issue.number}</a> in ${repoLink}`;
            if (shouldRenderBody) {
              if (payload.issue.short_description_html || payload.issue.body) {
                content += renderBodyOrShortHtml(
                  payload.issue.body,
                  payload.issue.short_description_html
                );
              } else if (payload.issue.title && md) {
                content += `<div style="font-size:90%;margin-top:2px;max-width:340px;margin-left:35px;overflow-wrap:break-word;">${DOMPurify.sanitize(
                  md.renderInline(payload.issue.title)
                )}</div>`;
              }
            }
          }
          break;
        case "PullRequestEvent":
          if (payload.pull_request) {
            content = `${actorAvatar}${actorLink} ${payload.action} pull request 
                    <a href="${payload.pull_request.html_url}" target="_blank" rel="noopener noreferrer">#${payload.pull_request.number}</a> in ${repoLink}`;
            if (shouldRenderBody) {
              if (
                payload.pull_request.short_description_html ||
                payload.pull_request.body
              ) {
                content += renderBodyOrShortHtml(
                  payload.pull_request.body,
                  payload.pull_request.short_description_html
                );
              } else if (payload.pull_request.title && md) {
                content += `<div style="font-size:90%;margin-top:2px;max-width:340px;margin-left:35px;overflow-wrap:break-word;">${DOMPurify.sanitize(
                  md.renderInline(payload.pull_request.title)
                )}</div>`;
              }
            }
          }
          break;
        case "PullRequestReviewEvent":
          if (payload.pull_request) {
            content = `${actorAvatar}${actorLink} reviewed pull request 
                    <a href="${payload.pull_request.html_url}" target="_blank" rel="noopener noreferrer">#${payload.pull_request.number}</a> in ${repoLink}`;
            if (shouldRenderBody && payload.review)
              content += renderBodyOrShortHtml(
                payload.review.body,
                payload.review.short_description_html
              );
          }
          break;
        case "PullRequestReviewCommentEvent":
          if (payload.pull_request) {
            content = `${actorAvatar}${actorLink} commented on pull request 
                    <a href="${payload.pull_request.html_url}" target="_blank" rel="noopener noreferrer">#${payload.pull_request.number}</a> in ${repoLink}`;
            if (shouldRenderBody && payload.comment)
              content += renderBodyOrShortHtml(
                payload.comment.body,
                payload.comment.short_description_html
              );
          }
          break;
        case "CommitCommentEvent":
          if (payload.comment && payload.comment.html_url) {
            content = `${actorAvatar}${actorLink} commented on 
                    <a href="${payload.comment.html_url}" target="_blank" rel="noopener noreferrer">a commit</a> in ${repoLink}`;
            if (shouldRenderBody)
              content += renderBodyOrShortHtml(
                payload.comment.body,
                payload.comment.short_description_html
              );
          }
          break;
        case "MemberEvent":
          if (payload.member) {
            content = `${actorAvatar}${actorLink} added <a href="https://github.com/${encodeURIComponent(
              payload.member.login
            )}" target="_blank" rel="noopener noreferrer">${DOMPurify.sanitize(
              payload.member.login
            )}</a> to ${repoLink}`;
          }
          break;
        case "GollumEvent":
          if (payload.pages && payload.pages[0]) {
            content = `${actorAvatar}${actorLink} edited wiki in ${repoLink}`;
            if (shouldRenderBody && md) {
              content += `<div style="font-size:90%;margin-top:2px;max-width:340px;margin-left:35px;overflow-wrap:break-word;">Page: ${DOMPurify.sanitize(
                md.renderInline(payload.pages[0].title)
              )}</div>`;
            }
          }
          break;
        case "ReleaseEvent":
          if (payload.release) {
            content = `${actorAvatar}${actorLink} ${payload.action} release 
                  <a href="${
                    payload.release.html_url
                  }" target="_blank" rel="noopener noreferrer">${DOMPurify.sanitize(
              payload.release.name || payload.release.tag_name
            )}</a> in ${repoLink}`;
            if (shouldRenderBody)
              content += renderBodyOrShortHtml(
                payload.release.body,
                payload.release.short_description_html
              );
          }
          break;
        case "SponsorshipEvent":
          content = `${actorAvatar}${actorLink} sponsored or received a sponsorship.`;
          break;
        default:
          content = `${actorAvatar}${actorLink} did <code>${DOMPurify.sanitize(
            type
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
    }

    // Format date
    const date = timeAgo(created_at);

    // Render card
    card.innerHTML = DOMPurify.sanitize(
      `<div>${content}</div>
      <div style="margin-top:7px;color:gray;font-size:85%">${date}</div>`
    );
    return card;
  }

  // ---- Entrypoint begins ----

  try {
    // Step 1: Setup state and menu
    rewriteConsole();
    shouldRenderBody = await GM.getValue(RENDER_BODY_KEY, false);
    initMarkdown();

    GM.registerMenuCommand("Configure GitHub Token", configureToken);
    await updateRenderBodyMenuCommand();

    // Step 2: Get token
    const token = await getToken();
    if (!token) {
      console.warn("No token configured, skipping.");
      return;
    }

    // Step 3: Wait for username and sidebar
    const [username, sidebar] = await Promise.all([
      waitForUsername(),
      waitForSidebar(),
    ]);
    if (!username) {
      console.warn("Could not find username, skipping.");
      return;
    }

    // Step 4: Render feed with pagination
    let currentPage = 1;
    const perPage = 25;

    async function render(page) {
      let events = [],
        lastPage = page;
      try {
        const data = await fetchReceivedEvents(username, token, perPage, page);
        events = Array.isArray(data.events) ? data.events : [];
        lastPage = data.lastPage;
      } catch (e) {
        events = [];
        lastPage = page;
      }

      // Cards section
      const cardsSection = document.createElement("div");
      cardsSection.style.display = "flex";
      cardsSection.style.flexDirection = "column";
      cardsSection.style.margin = "0 0 19px 0";
      cardsSection.style.gap = "0 2px";
      cardsSection.style.minHeight = "420px";

      // Header
      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.justifyContent = "flex-start";
      header.style.alignItems = "baseline";
      header.innerHTML = `<h3 style="font-size:18px;font-weight:600;margin:0 5px 16px 0">Your Received Events</h3>`;
      cardsSection.append(header);

      // Cards row
      const cardsRow = document.createElement("div");
      cardsRow.style.display = "flex";
      cardsRow.style.flexWrap = "wrap";
      cardsRow.style.gap = "0 2px";
      cardsRow.style.width = "100%";
      cardsRow.style.boxSizing = "border-box";
      cardsRow.style.minHeight = "330px";

      if (events.length === 0) {
        cardsRow.innerHTML =
          '<div style="color:#888;padding:12px">No events</div>';
      } else {
        const cards = await Promise.all(
          events.map((ev) => renderEventCard(ev))
        );
        for (const card of cards) {
          cardsRow.appendChild(card);
        }
      }
      cardsSection.appendChild(cardsRow);

      // Pagination
      cardsSection.appendChild(
        renderPaginationControls({
          page,
          lastPage,
          onPageChange: (p) => {
            if (p !== currentPage && p >= 1 && p <= lastPage) {
              currentPage = p;
              render(currentPage);
            }
          },
          containerId: FEED_SECTION_ID,
        })
      );

      // Insert section
      insertEventsSectionSibling(cardsSection, sidebar, FEED_SECTION_ID);
    }

    render(currentPage);
  } catch (e) {
    console.error("Unexpected failure:", e);
  }
})();
