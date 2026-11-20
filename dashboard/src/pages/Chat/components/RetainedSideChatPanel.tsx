import type { ResolvedModel } from "../../../api/types";
import { useSideChat, type RetainedSideChat } from "../hooks/useSideChat";
import SideChatPanel from "./SideChatPanel";
import SideChatShell from "./SideChatShell";

export interface RetainedSideChatPanelProps {
  descriptor: RetainedSideChat;
  ownerId: number | null;
  active: boolean;
  mobile: boolean;
  disabled?: boolean;
  availableModels?: ResolvedModel[];
  onPersisted: (descriptor: RetainedSideChat) => void;
  onCloseError: (descriptor: RetainedSideChat, error: unknown) => void;
  onPersistError: (descriptor: RetainedSideChat, error: unknown) => void;
}

export default function RetainedSideChatPanel({
  descriptor,
  ownerId,
  active,
  mobile,
  disabled = false,
  availableModels,
  onPersisted,
  onCloseError,
  onPersistError,
}: RetainedSideChatPanelProps) {
  const sideChat = useSideChat(
    descriptor.agentId,
    descriptor.sourceThreadId,
    ownerId,
  );
  const open = active && sideChat.visible;
  return (
    <SideChatShell open={open} mobile={mobile} onHide={sideChat.hide}>
      <SideChatPanel
        agentId={descriptor.agentId}
        thread={descriptor.thread}
        active={open}
        saving={sideChat.saving}
        disabled={disabled || !open || sideChat.closing}
        availableModels={availableModels}
        onHide={sideChat.hide}
        onClose={() => {
          void sideChat
            .close()
            .catch((error) => onCloseError(descriptor, error));
        }}
        onPersist={async () => {
          try {
            if (await sideChat.persist()) onPersisted(descriptor);
          } catch (error) {
            onPersistError(descriptor, error);
          }
        }}
      />
    </SideChatShell>
  );
}
