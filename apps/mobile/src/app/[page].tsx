import { Redirect, useLocalSearchParams } from "expo-router";
import { useWorkspaceContext } from "../workspace-context";
import WorkspaceScreen from "../workspace-screen";

const pages = ["manage", "profiles", "connection", "archive", "version", "cron", "models", "logs", "skills", "mcp", "conversation", "inbox-item"];

export default function SecondaryPage() {
  const { page, topicId } = useLocalSearchParams();
  const { inboxItem } = useWorkspaceContext();
  if (typeof page !== "string" || !pages.includes(page)
    || (page === "conversation" && (typeof topicId !== "string" || !topicId))
    || (page === "inbox-item" && !inboxItem)) {
    return <Redirect href="/" />;
  }
  return <WorkspaceScreen />;
}
