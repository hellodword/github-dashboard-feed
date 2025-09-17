// ==UserScript==
// @name         GitHub Dashboard Feed
// @namespace    https://github.com/hellodword/github-dashboard-feed
// @homepageURL  https://github.com/hellodword/github-dashboard-feed
// @icon         https://github.com/favicon.ico
// @version      0.2
// @description  Show your GitHub received events as dashboard-style cards
// @author       hellodword
// @match        https://github.com/
// @match        https://github.com/dashboard
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/hellodword/github-dashboard-feed/refs/heads/master/github-dashboard-feed.userscript.js
// ==/UserScript==

/**
 * Utilities for token management.
 * Violentmonkey users should set 'github_token' by editing the script values.
 */
async function getToken() {
    try {
        const token = await GM.getValue('github_token', '');
        return typeof token === 'string' && token.length > 0 ? token : null;
    } catch (e) {
        console.error("[GH Dashboard UserEvents] Error fetching token:", e);
        return null;
    }
}

/**
 * Attempts to get the logged-in username using various (robust) selectors.
 */
function getUsername() {
    try {
        const metaUserLogin = document.querySelector('meta[name="user-login"]');
        if (metaUserLogin && metaUserLogin.content) return metaUserLogin.content;
        const metaActorLogin = document.querySelector('meta[name="octolytics-actor-login"]');
        if (metaActorLogin && metaActorLogin.content) return metaActorLogin.content;
        const dataLogin = document.querySelector('[data-login]');
        if (dataLogin && dataLogin.getAttribute('data-login')) return dataLogin.getAttribute('data-login');
    } catch (e) {
        console.error("[GH Dashboard UserEvents] Error detecting username:", e);
    }
    return null;
}

/**
 * Waits for the username to be available in the DOM.
 */
function waitForUsername(timeout = 4000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        function poll() {
            const username = getUsername();
            if (username) {
                resolve(username);
            } else if (Date.now() - start > timeout) {
                reject(new Error("Timed out waiting for username"));
            } else {
                setTimeout(poll, 350);
            }
        }
        poll();
    });
}

/**
 * Fetches received events for a user from GitHub's API.
 */
async function fetchReceivedEvents(username, token, perPage = 30) {
    const url = `https://api.github.com/users/${encodeURIComponent(username)}/received_events?per_page=${perPage}`;
    try {
        const res = await fetch(url, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github+json'
            }
        });
        if (res.status === 401) {
            throw new Error("Token is invalid or expired");
        }
        if (!res.ok) {
            throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
        }
        return await res.json();
    } catch (error) {
        console.error("[GH Dashboard UserEvents] Fetch error:", error);
        throw error;
    }
}

/**
 * Renders a GitHub-styled dashboard card for an event, depending on its type.
 */
function renderEventCard(event) {
    const { type, repo, actor, created_at, payload } = event;
    const card = document.createElement('div');
    card.className = "dashboard-changelog color-bg-default border color-border-default p-3 rounded-2";
    card.style.flex = "1 1 320px";
    card.style.minWidth = "260px";
    card.style.margin = "0 8px 8px 0";

    // Actor and repo visualization
    const actorLink = actor ? `<a style="font-weight:bold" href="https://github.com/${actor.login}" target="_blank">${actor.login}</a>` : '';
    const actorAvatar = actor ? `<img src="${actor.avatar_url}" style="width:28px;height:28px;border-radius:50%;margin-right:7px;vertical-align:middle;">` : '';
    const repoLink = repo ? `<a style="font-weight:bold" href="https://github.com/${repo.name}" target="_blank">${repo.name}</a>` : '';

    // Compose message based on event type
    let content = '';
    switch (type) {
        case 'WatchEvent':
            // payload.action: "started"
            content = `${actorAvatar}${actorLink} ${payload.action === "started" ? "starred" : payload.action} ${repoLink}`;
            break;
        case 'ForkEvent':
            content = `${actorAvatar}${actorLink} forked ${repoLink}`;
            if (payload.forkee && payload.forkee.html_url) {
                content += ` (<a href="${payload.forkee.html_url}" target="_blank">new fork</a>)`;
            }
            break;
        case 'PushEvent':
            const commits = payload.commits || [];
            content = `${actorAvatar}${actorLink} pushed to ${repoLink}`;
            if (commits.length > 0) {
                content += `<ul style="margin-top:3px;">${commits.slice(0,3).map(commit =>
                    `<li style="font-size:90%">${commit.message}
                    <span style="color:gray">(${commit.author.name})</span>
                    </li>`
                ).join('')}</ul>`;
            }
            break;
        case 'CreateEvent':
            content = `${actorAvatar}${actorLink} created ${payload.ref_type} <strong>${payload.ref}</strong> in ${repoLink}`;
            break;
        case 'DeleteEvent':
            content = `${actorAvatar}${actorLink} deleted ${payload.ref_type} <strong>${payload.ref}</strong> in ${repoLink}`;
            break;
        case 'PublicEvent':
            content = `${actorAvatar}${actorLink} open sourced ${repoLink}`;
            break;
        case 'IssueCommentEvent':
            if (payload.issue) {
                content = `${actorAvatar}${actorLink} commented on 
                           <a href="${payload.issue.html_url}" target="_blank">issue #${payload.issue.number}</a> in ${repoLink}`;
                if (payload.comment && payload.comment.body) {
                    content += `<blockquote style="margin:4px 0 0 2px;font-size:90%;color:#555;background:#f8f8fa">${payload.comment.body.substring(0,90)}...</blockquote>`;
                }
            }
            break;
        case 'IssuesEvent':
            if (payload.issue) {
                content = `${actorAvatar}${actorLink} ${payload.action} issue
                  <a href="${payload.issue.html_url}" target="_blank">#${payload.issue.number}</a> in ${repoLink}`;
                if (payload.issue.title) {
                    content += `<div style="font-size:90%;margin-top:2px">${payload.issue.title}</div>`;
                }
            }
            break;
        case 'PullRequestEvent':
            if (payload.pull_request) {
                content = `${actorAvatar}${actorLink} ${payload.action} pull request 
                  <a href="${payload.pull_request.html_url}" target="_blank">#${payload.pull_request.number}</a> in ${repoLink}`;
                if (payload.pull_request.title) {
                    content += `<div style="font-size:90%;margin-top:2px">${payload.pull_request.title}</div>`;
                }
            }
            break;
        case 'PullRequestReviewEvent':
            if (payload.pull_request) {
                content = `${actorAvatar}${actorLink} reviewed pull request 
                  <a href="${payload.pull_request.html_url}" target="_blank">#${payload.pull_request.number}</a> in ${repoLink}`;
                if (payload.review && payload.review.body) {
                    content += `<blockquote style="margin:4px 0 0 2px;font-size:90%;color:#555;background:#f8f8fa">${payload.review.body.substring(0,90)}...</blockquote>`;
                }
            }
            break;
        case 'PullRequestReviewCommentEvent':
            if (payload.pull_request) {
                content = `${actorAvatar}${actorLink} commented on pull request 
                  <a href="${payload.pull_request.html_url}" target="_blank">#${payload.pull_request.number}</a> in ${repoLink}`;
                if (payload.comment && payload.comment.body) {
                    content += `<blockquote style="margin:4px 0 0 2px;font-size:90%;color:#555;background:#f8f8fa">${payload.comment.body.substring(0,90)}...</blockquote>`;
                }
            }
            break;
        case 'CommitCommentEvent':
            if (payload.comment && payload.comment.html_url) {
                content = `${actorAvatar}${actorLink} commented on 
                  <a href="${payload.comment.html_url}" target="_blank">a commit</a> in ${repoLink}`;
                if (payload.comment.body) {
                    content += `<blockquote style="margin:4px 0 0 2px;font-size:90%;color:#555;background:#f8f8fa">${payload.comment.body.substring(0,90)}...</blockquote>`;
                }
            }
            break;
        case 'MemberEvent':
            if (payload.member) {
                content = `${actorAvatar}${actorLink} added <a href="https://github.com/${payload.member.login}" target="_blank">${payload.member.login}</a> to ${repoLink}`;
            }
            break;
        case 'GollumEvent':
            if (payload.pages && payload.pages[0]) {
                content = `${actorAvatar}${actorLink} edited wiki in ${repoLink}`;
                content += `<div style="font-size:90%;margin-top:2px">Page: ${payload.pages[0].title}</div>`;
            }
            break;
        case 'ReleaseEvent':
            content = `${actorAvatar}${actorLink} ${payload.action} release 
                <a href="${payload.release.html_url}" target="_blank">${payload.release.name || payload.release.tag_name}</a>
                in ${repoLink}`;
            break;
        case 'SponsorshipEvent':
            content = `${actorAvatar}${actorLink} sponsored or received a sponsorship.`;
            break;
        default:
            content = `${actorAvatar}${actorLink} did <code>${type}</code> in ${repoLink}`;
    }
    // Timestamp
    const date = new Date(created_at).toLocaleString();
    card.innerHTML = `<div>${content}</div>
        <div style="margin-top:7px;color:gray;font-size:85%">${date}</div>`;
    return card;
}

/**
 * Find insertion point: immediately next to the dashboard cards.
 */
function insertEventsSection(cardsWrapper) {
    const refDiv = document.querySelector('div.dashboard-changelog, div.mb-3.dashboard-changelog');
    if (refDiv && refDiv.parentElement) {
        refDiv.parentElement.insertBefore(cardsWrapper, refDiv.nextSibling);
    } else {
        // fallback, place at top of body
        document.body.prepend(cardsWrapper);
    }
}

/**
 * Main logic: orchestrates all steps, logs to console on error.
 */
(async function run() {
    try {
        const token = await getToken();
        if (!token) {
            console.warn('[GH Dashboard UserEvents] No token configured, skipping.');
            return;
        }
        const username = await waitForUsername();
        if (!username) {
            console.warn('[GH Dashboard UserEvents] Could not find username, skipping.');
            return;
        }
        const events = await fetchReceivedEvents(username, token, 25);
        if (!Array.isArray(events) || events.length === 0) {
            console.info('[GH Dashboard UserEvents] No events found.');
            return;
        }
        // Section wrapper
        const cardsSection = document.createElement('div');
        cardsSection.style.display = 'flex';
        cardsSection.style.flexWrap = 'wrap';
        cardsSection.style.margin = '0 0 19px 0';
        cardsSection.style.gap = "0 2px";
        cardsSection.innerHTML = `<h3 style="font-size:18px;font-weight:600;margin:0 5px 16px 0">Your Received Events</h3>`;
        // Attach rendered event cards
        for (const event of events) {
            try {
                cardsSection.appendChild(renderEventCard(event));
            } catch (e) {
                console.error("[GH Dashboard UserEvents] Error rendering card:", event, e);
            }
        }
        insertEventsSection(cardsSection);
    } catch (e) {
        console.error("[GH Dashboard UserEvents] Unexpected failure:", e);
    }
})();
