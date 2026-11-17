// The whole UI: load the shared data once, pick the page from the address, draw it inside the shell.
import type { ReactElement } from "react";
import { Shell } from "./components/Shell";
import { useData } from "./lib/data";
import { useRoute } from "./lib/router";
import { Account } from "./pages/Account";
import { Project } from "./pages/Project";
import { Repo } from "./pages/Repo";
import { Run } from "./pages/Run";

export function App() {
  const d = useData();
  const route = useRoute();
  const page = (): ReactElement => {
    if (!d.ws) return <div className="page"><div className={d.error ? "err" : "empty"}>{d.error ?? "Loading"}</div></div>;
    switch (route.page) {
      case "project": return <Project ws={d.ws} runs={d.runs} orgId={route.org} projectId={route.project} onSaved={d.setWs} />;
      case "repo": return <Repo ws={d.ws} runs={d.runs} repo={route.repo} onStarted={d.reload} />;
      case "run": return <Run ws={d.ws} source={route.source} run={route.run} />;
      default: return <Account ws={d.ws} runs={d.runs} onSaved={d.setWs} />;
    }
  };
  return <Shell ws={d.ws} runs={d.runs} route={route}>{page()}</Shell>;
}
