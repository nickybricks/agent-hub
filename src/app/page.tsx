import Link from "next/link";
import { redirect } from "next/navigation";
import { isMultiTenant } from "@/lib/db";
import { getConfig, getRuns } from "@/lib/data";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  // In the SaaS (multi-tenant) deployment the product is the /app shell; the
  // legacy flat-file dashboard below is local single-user dev only.
  if (isMultiTenant()) redirect("/app");

  const config = getConfig();
  const runs = getRuns(undefined, 5);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
        <p className="text-muted text-sm">
          Overview of all your AI agents and their recent activity.
        </p>
      </div>

      {/* Agent Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {config.agents.map((agent) => {
          const agentRuns = runs.filter((r) => r.agentId === agent.id);
          const lastRun = agentRuns[0];

          return (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="card p-5 group block hover:bg-card-hover"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{agent.icon}</span>
                  <div>
                    <h3 className="font-semibold group-hover:text-accent transition-colors">
                      {agent.name}
                    </h3>
                    <p className="text-xs text-muted">
                      {agent.schedule.enabled
                        ? `Daily at ${agent.schedule.time}`
                        : "Manual only"}
                    </p>
                  </div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    agent.enabled
                      ? "bg-success-soft text-success"
                      : "bg-background-secondary text-muted"
                  }`}
                >
                  {agent.enabled ? "Active" : "Disabled"}
                </span>
              </div>
              <p className="text-sm text-muted mb-3 line-clamp-2">
                {agent.description}
              </p>
              {lastRun && (
                <div className="text-xs text-muted border-t border-border pt-2">
                  Last run:{" "}
                  {new Date(lastRun.startedAt).toLocaleString()} —{" "}
                  <span
                    className={
                      lastRun.status === "completed"
                        ? "text-success"
                        : lastRun.status === "failed"
                          ? "text-danger"
                          : "text-warning"
                    }
                  >
                    {lastRun.status}
                  </span>
                </div>
              )}
            </Link>
          );
        })}

        {/* Add Agent Card */}
        <div className="bg-card border border-dashed border-border rounded-[1.25rem] p-5 flex items-center justify-center text-muted hover:border-accent/40 hover:text-accent transition-colors cursor-pointer">
          <div className="text-center">
            <div className="text-3xl mb-2">+</div>
            <p className="text-sm font-medium">Add Agent</p>
          </div>
        </div>
      </div>

      {/* Recent Runs */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Recent Runs</h2>
        {runs.length === 0 ? (
          <div className="card p-8 text-center text-muted">
            <p className="text-sm">No runs yet.</p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Started</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const agent = config.agents.find(
                    (a) => a.id === run.agentId
                  );
                  const duration =
                    run.completedAt
                      ? `${Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                      : "...";
                  return (
                    <tr
                      key={run.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-4 py-3">
                        {agent?.icon} {agent?.name || run.agentId}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            run.status === "completed"
                              ? "bg-success-soft text-success"
                              : run.status === "failed"
                                ? "bg-danger-soft text-danger"
                                : "bg-warning-soft text-warning"
                          }`}
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {new Date(run.startedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-muted">{duration}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
