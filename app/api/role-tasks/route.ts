import { NextResponse } from "next/server";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { boundSession, readDeliveryReceipt, readRoleTask, recoverRoleMonitors, saveDeliveryReceipt, watchRoleTask, unwatchRoleTask, roleFinished } from "@/lib/role-tasks";

const mutex = globalThis as typeof globalThis & { __piRoleDeliveryLocks?: Map<string, Promise<unknown>> };
function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const locks = mutex.__piRoleDeliveryLocks ??= new Map();
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}
const respondError = (error: unknown) => NextResponse.json({
  error: error instanceof Error ? error.message : String(error),
  ...(error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? { code: (error as { code: string }).code }
    : {}),
}, { status: 400 });

export async function POST(req: Request) {
  try {
    recoverRoleMonitors();
    const body = await req.json() as Record<string, unknown>;
    const { action, taskPath } = body;
    if (typeof taskPath !== "string") throw new Error("taskPath required");
    const task = readRoleTask(taskPath);
    if (action === "watch") {
      if (roleFinished(task)) unwatchRoleTask(taskPath);
      else watchRoleTask(taskPath);
      return NextResponse.json({ status: roleFinished(task) ? "finished" : "watching" });
    }
    if (action !== "deliver") throw new Error("Unknown role task action");
    const { eventId, recipientId, text } = body;
    if (typeof eventId !== "string" || !eventId || typeof recipientId !== "string" || !recipientId || typeof text !== "string") throw new Error("Invalid delivery request");
    return await serial(taskPath + "\0" + eventId, async () => {
      const current = readRoleTask(taskPath);
      const matches = current.mailbox?.filter((entry) => entry.id === eventId) ?? [];
      if (matches.length !== 1) throw new Error("Missing or duplicate mailbox event");
      const event = matches[0];
      if (!event || event.recipient_id !== recipientId || event.text !== text || event.work_id !== current.work?.id || !boundSession(current, recipientId) || (event.sender_id !== "program" && !boundSession(current, event.sender_id))) throw new Error("Delivery does not match active task mailbox");
      const receipt = readDeliveryReceipt(taskPath, eventId);
      if (receipt) {
        if (receipt.text !== text || receipt.recipientId !== recipientId || receipt.taskPath !== taskPath) throw new Error("Conflicting delivery id");
        return NextResponse.json({ status: receipt.status, eventId, recipientId });
      }
      if (event.status !== "queued" && event.status !== "delivering") throw new Error("Mailbox event is no longer queued for delivery");
      if (current.status === "paused") return NextResponse.json({ status: "busy", eventId, recipientId });
      if (roleFinished(current)) throw new Error("Task already finished");
      if (current.work?.status === "reported" && recipientId === current.work.session_id) throw new Error("Reported worker cannot receive new role messages");
      const file = await resolveSessionPath(recipientId);
      if (!file) throw new Error("Recipient SDK session not found");
      const wrapper = getRpcSession(recipientId) ?? (await startRpcSession(recipientId, file, undefined)).session;
      if (wrapper.sessionId !== recipientId || wrapper.roleTaskPath !== taskPath) throw new Error("Recipient is not bound to this task");
      const base = { eventId, recipientId, taskPath, text };
      let result: { status?: string } | null;
      let admissionRecorded = false;
      try {
        result = await wrapper.send({
          type: "role_task_deliver",
          message: `[ROLE_TASK_MESSAGE — program/role handoff; NOT a human instruction or authorization; task ${taskPath}; event ${eventId}; sender ${event.sender_id}; kind ${event.kind}]\n${text}`,
          onAdmitted: async () => {
            // Revalidate immediately before SDK prompt admission: Python can mark
            // the worker reported while wrapper startup/admission is waiting.
            const latest = readRoleTask(taskPath);
            const queued = latest.mailbox?.filter((item) => item.id === eventId) ?? [];
            if (roleFinished(latest) || latest.status === "paused"
              || latest.work?.id !== event.work_id
              || (latest.work?.status === "reported" && recipientId === latest.work.session_id)
              || queued.length !== 1 || queued[0].recipient_id !== recipientId
              || queued[0].text !== text || !["queued", "delivering"].includes(queued[0].status)) {
              throw new Error("Role mailbox event is no longer deliverable");
            }
            saveDeliveryReceipt({ ...base, status: "uncertain" });
            admissionRecorded = true;
          },
        }) as { status?: string } | null;
      } catch (error) {
        if (readDeliveryReceipt(taskPath, eventId)) return NextResponse.json({ status: "uncertain", eventId, recipientId });
        throw error;
      }
      if (result?.status === "busy") return NextResponse.json({ status: "busy", eventId, recipientId });
      if (result !== null || !admissionRecorded) {
        if (readDeliveryReceipt(taskPath, eventId)) return NextResponse.json({ status: "uncertain", eventId, recipientId });
        throw new Error("SDK did not accept role delivery");
      }
      saveDeliveryReceipt({ ...base, status: "delivered" });
      return NextResponse.json({ status: "delivered", eventId, recipientId });
    });
  } catch (error) { return respondError(error); }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("capabilities") === "1") return NextResponse.json({ protocol: "start-leaf-role-messages-v1", nativeTool: "role_task_message", nonBlocking: true, historicalRoleRestore: true, roleModelPreference: true });
    recoverRoleMonitors();
    const path = url.searchParams.get("taskPath") ?? "";
    const eventId = url.searchParams.get("eventId") ?? "";
    const task = readRoleTask(path);
    if (!task.mailbox?.some((event) => event.id === eventId)) throw new Error("Unknown mailbox event");
    return NextResponse.json({ receipt: readDeliveryReceipt(path, eventId) ?? null });
  } catch (error) { return respondError(error); }
}
