import ChatPanel from "@/components/ChatPanel";

export default function ChatPage() {
  return (
    <div className="mx-auto h-[calc(100vh-2rem)] max-w-3xl p-4">
      <div className="card h-full overflow-hidden">
        <ChatPanel />
      </div>
    </div>
  );
}
