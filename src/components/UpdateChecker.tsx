import { useState, useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { X } from "lucide-react";

type Stage = "available" | "downloading" | "done" | "error";

export function UpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [stage, setStage] = useState<Stage>("available");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    check()
      .then((u) => {
        if (u?.available) setUpdate(u);
      })
      .catch(() => {});
  }, []);

  if (!update || dismissed) return null;

  const handleUpdate = async () => {
    setStage("downloading");
    setProgress(0);
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            setProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setStage("done");
    } catch (e) {
      setStage("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRelaunch = async () => {
    await relaunch();
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 bg-card border border-border rounded-xl shadow-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Update Available
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            v{update.version} is ready
          </p>
        </div>
        {stage === "available" && (
          <button
            onClick={() => setDismissed(true)}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {stage === "downloading" && (
        <div className="space-y-1.5">
          <Progress value={progress} className="h-1.5" />
          <p className="text-xs text-muted-foreground text-right">
            {progress}%
          </p>
        </div>
      )}

      {stage === "error" && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        {stage === "available" && (
          <Button size="sm" onClick={handleUpdate}>
            Update Now
          </Button>
        )}
        {stage === "done" && (
          <Button size="sm" onClick={handleRelaunch}>
            Relaunch
          </Button>
        )}
        {stage === "error" && (
          <Button size="sm" variant="outline" onClick={handleUpdate}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
