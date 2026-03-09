import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { historyApi } from "./api";
import { pageConfig } from "./config";
import type { Pagination, Project, Session, Turn } from "./types";

type SessionBag = {
  items: Session[];
  pagination: Pagination | null;
  loading: boolean;
  error: string;
};

type TurnDetailState = {
  loading: boolean;
  data: Turn | null;
  error: string;
};

const PROJECT_PAGE_SIZE = 50;

function formatTime(value: number) {
  if (!value) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(value * 1000);
}

function formatRelative(value: number) {
  if (!value) {
    return "未知";
  }
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - value);
  if (delta < 60) {
    return "刚刚";
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)} 分钟前`;
  }
  if (delta < 86400) {
    return `${Math.floor(delta / 3600)} 小时前`;
  }
  return `${Math.floor(delta / 86400)} 天前`;
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}小时${minutes}分${secs}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${secs}秒`;
  }
  return `${secs}秒`;
}

function statusLabel(status: string) {
  switch (status) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "running":
      return "进行中";
    default:
      return status || "未知";
  }
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsPagination, setProjectsPagination] = useState<Pagination | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [sessionMap, setSessionMap] = useState<Record<string, SessionBag>>({});
  const [activeProject, setActiveProject] = useState("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsPagination, setTurnsPagination] = useState<Pagination | null>(null);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsError, setTurnsError] = useState("");
  const [loadingOlderTurns, setLoadingOlderTurns] = useState(false);
  const [turnDetails, setTurnDetails] = useState<Record<string, TurnDetailState>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const currentSessionBag = useMemo(() => sessionMap[activeProject], [sessionMap, activeProject]);
  const turnLimit = Math.max(20, Math.min(100, Number(pageConfig.initialTurnLimit || 50)));

  useEffect(() => {
    void loadProjects();
  }, []);

  async function loadProjects(append = false) {
    setProjectsLoading(true);
    setProjectsError("");
    try {
      const offset = append && projectsPagination ? projectsPagination.offset + projectsPagination.limit : 0;
      const response = await historyApi.getProjects(offset, PROJECT_PAGE_SIZE);
      const payload = response.data;
      setProjects((prev) => (append ? prev.concat(payload.projects) : payload.projects));
      setProjectsPagination(payload.pagination);
      if (!append && payload.projects.length > 0) {
        const preferredProject = pageConfig.initialProject;
        const nextProject = preferredProject && payload.projects.some((item) => item.name === preferredProject)
          ? preferredProject
          : payload.projects[payload.projects.length - 1].name;
        setExpandedProjects((prev) => ({ ...prev, [nextProject]: true }));
        await loadSessions(nextProject, false, pageConfig.initialChatId);
      }
    } catch (error) {
      setProjectsError(String((error as Error).message || error));
    } finally {
      setProjectsLoading(false);
    }
  }

  async function loadSessions(projectName: string, append = false, preferredChatId = "") {
    setActiveProject(projectName);
    setExpandedProjects((prev) => ({ ...prev, [projectName]: true }));
    setSessionMap((prev) => ({
      ...prev,
      [projectName]: {
        items: append ? prev[projectName]?.items || [] : [],
        pagination: prev[projectName]?.pagination || null,
        loading: true,
        error: ""
      }
    }));

    try {
      const bag = sessionMap[projectName];
      const offset = append && bag?.pagination ? bag.pagination.offset + bag.pagination.limit : 0;
      const response = await historyApi.getSessions(projectName, offset, 50);
      const payload = response.data;
      const nextItems = append && bag ? bag.items.concat(payload.sessions) : payload.sessions;

      setSessionMap((prev) => ({
        ...prev,
        [projectName]: {
          items: nextItems,
          pagination: payload.pagination,
          loading: false,
          error: ""
        }
      }));

      const nextSession =
        (preferredChatId && nextItems.find((item) => item.chat_id === preferredChatId)) ||
        nextItems[nextItems.length - 1] ||
        null;

      if (nextSession) {
        await selectSession(nextSession);
      } else if (!append) {
        setActiveSession(null);
        setTurns([]);
        setTurnsPagination(null);
      }
    } catch (error) {
      setSessionMap((prev) => ({
        ...prev,
        [projectName]: {
          items: prev[projectName]?.items || [],
          pagination: prev[projectName]?.pagination || null,
          loading: false,
          error: String((error as Error).message || error)
        }
      }));
    }
  }

  async function selectSession(session: Session) {
    setActiveProject(session.project);
    setActiveSession(session);
    setTurnsError("");
    setTurnDetails({});
    await loadTurns(session, false);
  }

  async function loadTurns(session: Session, appendOlder: boolean) {
    const baseOffset = Math.max(0, Number(session.turn_count || 0) - turnLimit);
    const nextOffset = appendOlder
      ? Math.max(0, (turnsPagination?.offset || baseOffset) - turnLimit)
      : baseOffset;

    if (appendOlder) {
      setLoadingOlderTurns(true);
    } else {
      setTurnsLoading(true);
    }
    setTurnsError("");

    try {
      const response = await historyApi.getTurns(session.project, session.chat_id, nextOffset, turnLimit, false);
      const payload = response.data;
      setTurnsPagination(payload.pagination);
      setTurns((prev) => (appendOlder ? payload.turns.concat(prev) : payload.turns));

      if (!appendOlder) {
        window.requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        });
      }
    } catch (error) {
      setTurnsError(String((error as Error).message || error));
    } finally {
      setTurnsLoading(false);
      setLoadingOlderTurns(false);
    }
  }

  async function toggleTurnDetail(turn: Turn, expanded: boolean) {
    const key = turn.turn_id || turn.id;
    if (expanded || turnDetails[key]?.data || turnDetails[key]?.loading) {
      return;
    }
    setTurnDetails((prev) => ({
      ...prev,
      [key]: { loading: true, data: null, error: "" }
    }));

    try {
      const response = await historyApi.getTurn(key, true);
      setTurnDetails((prev) => ({
        ...prev,
        [key]: { loading: false, data: response.data.turn, error: "" }
      }));
    } catch (error) {
      setTurnDetails((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          data: null,
          error: String((error as Error).message || error)
        }
      }));
    }
  }

  return (
    <div className="dashboard-shell">
      <aside className={`sidebar${activeSession ? " sidebar-collapsed-mobile" : ""}`}>
        <div className="sidebar-header">
          <div>
            <div className="eyebrow">FeiCodex</div>
            <h1>项目看板</h1>
          </div>
          <a className="ghost-link" href="/history/logout">
            退出
          </a>
        </div>

        {projectsError ? <div className="error-panel">{projectsError}</div> : null}

        <div className="sidebar-scroll">
          {projectsLoading && projects.length === 0 ? <div className="empty-panel">正在加载项目...</div> : null}

          {projects.map((project) => {
            const bag = sessionMap[project.name];
            const isExpanded = expandedProjects[project.name] ?? false;
            const isActiveProject = activeProject === project.name;
            return (
              <section
                key={project.name}
                className={`project-card${isActiveProject ? " project-card-active" : ""}`}
              >
                <button
                  className="project-button"
                  onClick={() => {
                    setExpandedProjects((prev) => ({ ...prev, [project.name]: !isExpanded }));
                    if (!isExpanded && !bag) {
                      void loadSessions(project.name, false, "");
                    } else {
                      setActiveProject(project.name);
                    }
                  }}
                >
                  <div className="project-meta">
                    <div className="project-name">{project.name}</div>
                    <div className="project-submeta">
                      <span>{project.session_count} 会话</span>
                      <span>{project.turn_count} 轮</span>
                      <span>{formatRelative(project.updated_at)}</span>
                    </div>
                  </div>
                  <div className="chevron">{isExpanded ? "▾" : "▸"}</div>
                </button>

                {isExpanded ? (
                  <div className="session-group">
                    {bag?.loading ? <div className="empty-panel compact">正在加载会话...</div> : null}
                    {bag?.error ? <div className="error-panel compact">{bag.error}</div> : null}
                    {!bag?.loading && !bag?.error && bag?.items.length === 0 ? (
                      <div className="empty-panel compact">这个项目还没有会话。</div>
                    ) : null}
                    {bag?.items.map((session) => {
                      const isActive =
                        activeSession?.project === session.project && activeSession?.chat_id === session.chat_id;
                      return (
                        <button
                          key={`${session.project}:${session.chat_id}`}
                          className={`session-card${isActive ? " session-card-active" : ""}`}
                          onClick={() => void selectSession(session)}
                        >
                          <div className="session-card-head">
                            <div className="session-title">{session.display_title || "未命名会话"}</div>
                            <span className={`status-pill status-${session.latest_status || "idle"}`}>
                              {statusLabel(session.latest_status)}
                            </span>
                          </div>
                          <div className="session-preview">
                            {session.display_preview || session.latest_error_preview || "暂无摘要"}
                          </div>
                          <div className="session-foot">
                            <span>{formatRelative(session.latest_updated_at || session.updated_at)}</span>
                            <span>{session.turn_count} 轮</span>
                          </div>
                        </button>
                      );
                    })}

                    {bag?.pagination?.has_more ? (
                      <button
                        className="load-more"
                        onClick={() => void loadSessions(project.name, true, "")}
                        disabled={bag.loading}
                      >
                        加载更多会话
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}

          {projectsPagination?.has_more ? (
            <button className="load-more" onClick={() => void loadProjects(true)} disabled={projectsLoading}>
              加载更多项目
            </button>
          ) : null}
        </div>
      </aside>

      <main className={`content-pane${activeSession ? " content-pane-active" : ""}`}>
        {activeSession ? (
          <>
            <header className="content-header">
              <button className="mobile-back" onClick={() => setActiveSession(null)}>
                返回
              </button>
              <div className="content-header-main">
                <div className="breadcrumb">{activeSession.project}</div>
                <h2>{activeSession.display_title || activeSession.chat_id}</h2>
                <div className="content-submeta">
                  <span>{activeSession.model || "default"}</span>
                  <span>{activeSession.auth_profile || "default"}</span>
                  <span>{activeSession.cwd || "未设置工作目录"}</span>
                </div>
              </div>
            </header>

            <div className="turns-scroll" ref={scrollRef}>
              <div className="turns-topbar">
                <div>
                  按自然时间顺序显示，默认定位到最新一段。
                  {turnsPagination ? ` 当前已加载 ${turns.length} / ${turnsPagination.total} 轮。` : ""}
                </div>
                {turnsPagination?.offset ? (
                  <button
                    className="load-more"
                    onClick={() => void loadTurns(activeSession, true)}
                    disabled={loadingOlderTurns}
                  >
                    {loadingOlderTurns ? "正在加载..." : "加载更早轮次"}
                  </button>
                ) : null}
              </div>

              {turnsError ? <div className="error-panel">{turnsError}</div> : null}
              {turnsLoading ? <div className="empty-panel">正在加载轮次...</div> : null}
              {!turnsLoading && turns.length === 0 ? <div className="empty-panel">这个会话还没有轮次。</div> : null}

              <div className="turn-list">
                {turns.map((turn) => {
                  const detailKey = turn.turn_id || turn.id;
                  const detail = turnDetails[detailKey];
                  return (
                    <article className="turn-card" key={detailKey}>
                      <div className="turn-user-row">
                        <div className="user-bubble">{turn.user_text || "无输入"}</div>
                      </div>

                      <div className="assistant-row">
                        <div className="assistant-avatar">C</div>
                        <div className="assistant-stack">
                          <div className="assistant-meta">
                            <span className="assistant-name">FeiCodex</span>
                            <span>{formatTime(turn.started_at)}</span>
                            <span>{formatDuration(turn.duration_sec)}</span>
                            <span className={`status-pill status-${turn.status || "idle"}`}>
                              {statusLabel(turn.status)}
                            </span>
                          </div>

                          {turn.events_count > 0 || turn.error_text ? (
                            <details
                              className="process-card"
                              onToggle={(event) =>
                                void toggleTurnDetail(
                                  turn,
                                  (event.currentTarget as HTMLDetailsElement).open
                                )
                              }
                            >
                              <summary>
                                <span>过程记录</span>
                                <span>{turn.events_count} 条</span>
                              </summary>
                              <div className="process-body">
                                {detail?.loading ? <div className="empty-panel compact">正在加载过程记录...</div> : null}
                                {detail?.error ? <div className="error-panel compact">{detail.error}</div> : null}
                                {detail?.data?.events?.length ? (
                                  <ol className="event-list">
                                    {detail.data.events.map((eventItem, index) => (
                                      <li key={`${detailKey}:${index}`}>
                                        <span className="event-time">{formatTime(eventItem.ts)}</span>
                                        <span>{eventItem.text}</span>
                                      </li>
                                    ))}
                                  </ol>
                                ) : null}
                                {(detail?.data?.error_text || turn.error_text) && !detail?.loading ? (
                                  <div className="error-block">{detail?.data?.error_text || turn.error_text}</div>
                                ) : null}
                                {!detail?.loading &&
                                !detail?.error &&
                                !(detail?.data?.events?.length || detail?.data?.error_text || turn.error_text) ? (
                                  <div className="empty-panel compact">暂无过程记录。</div>
                                ) : null}
                              </div>
                            </details>
                          ) : null}

                          {turn.error_text ? <div className="error-block">{turn.error_text}</div> : null}

                          <div className="assistant-card markdown-body">
                            <ReactMarkdown>{turn.assistant_text || "无最终回复"}</ReactMarkdown>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-kicker">项目 → 会话 → 轮次</div>
            <h2>先选择一个会话</h2>
            <p>左侧会展示项目与会话摘要，右侧按时间顺序回放每一轮历史。</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
