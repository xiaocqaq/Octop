import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { MessageSquare, PanelRightClose, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OctopThread } from "../../../api/modules/octopThreads";
import type { ResolvedModel } from "../../../api/types";
import type { HitlDecisionHandler } from "../../../api/types/hitl";
import { useChat, type ChatAttachment } from "../hooks/useChat";
import * as chatStore from "../hooks/chatStore";
import { buildComposerContext } from "../utils/chatMessages";
import {
  mergeAllowTools,
  parseHitlSessionPolicy,
  type HitlSessionPolicy,
} from "../utils/hitlSessionPolicy";
import {
  findAutoResumableApproval,
  findPendingAsk,
  hasPendingHitl,
} from "../utils/pendingHitl";
import AskQuestionCard from "./AskQuestionCard";
import ChatInput from "./ChatInput";
import MessageList from "./MessageList";
import styles from "./SideChatPanel.module.less";

export interface SideChatPanelProps {
  agentId: string;
  thread: OctopThread;
  onClose: () => void;
  onHide?: () => void;
  onPersist: () => Promise<void>;
  saving?: boolean;
  active?: boolean;
  disabled?: boolean;
  availableModels?: ResolvedModel[];
}

export default function SideChatPanel(props: SideChatPanelProps) {
  return (
    <SideChatPanelContent
      key={`${props.agentId}:${props.thread.thread_id}`}
      {...props}
    />
  );
}

function SideChatPanelContent({
  agentId,
  thread,
  onClose,
  onHide,
  onPersist,
  saving = false,
  active = true,
  disabled = false,
  availableModels,
}: SideChatPanelProps) {
  const { t } = useTranslation();
  const threadId = thread.thread_id;
  const {
    messages,
    isStreaming,
    thinkingStartedAt,
    liveSpeakers,
    historyLoading,
    historyError,
    historyHasMore,
    historyLoadingMore,
    historyRefreshing,
    sendMessage,
    cancelStream,
    loadHistory,
    loadMoreHistory,
    refreshHistory,
    retryHistory,
    resumeHitl,
  } = useChat(threadId, agentId, false, true);
  const [selectedModel, setSelectedModel] = useState(thread.model_ref ?? null);
  const [reasoning, setReasoning] = useState({
    mode: thread.reasoning_mode ?? "auto",
    effort: thread.reasoning_effort ?? null,
  });
  const [conversationMode, setConversationMode] = useState(
    thread.conversation_mode ?? "craft",
  );
  const [hitlPolicy, setHitlPolicy] = useState(() =>
    parseHitlSessionPolicy(thread.hitl_policy),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const autoResumedApprovalRef = useRef<string | null>(null);
  const pendingAsk = findPendingAsk(messages);
  const pendingHitl = hasPendingHitl(messages);
  const unavailable = disabled || saving;
  const inputDisabled = unavailable || historyLoading;

  useEffect(() => {
    // useChat invalidates outstanding history reads when this keyed pane unmounts.
    void loadHistory(threadId);
  }, [loadHistory, threadId]);

  const handleHitlDecision = useCallback<HitlDecisionHandler>(
    (decisions, policy, pendingId) => {
      if (unavailable) return;
      if (policy) {
        const next =
          policy.mode === "allow_tools"
            ? mergeAllowTools(hitlPolicy, policy.tools ?? [])
            : policy;
        const pending = findAutoResumableApproval(next, messages);
        if (pending) autoResumedApprovalRef.current = pending.messageId;
        setHitlPolicy(next);
        resumeHitl(
          decisions,
          threadId,
          undefined,
          next,
          pendingId ?? pending?.pendingId,
        );
      } else {
        resumeHitl(decisions, threadId, undefined, undefined, pendingId);
      }
      setNotice(null);
    },
    [unavailable, hitlPolicy, messages, resumeHitl, threadId],
  );

  const handlePolicyChange = useCallback(
    (policy: HitlSessionPolicy) => {
      if (unavailable) return;
      setHitlPolicy(policy);
      const pending = findAutoResumableApproval(policy, messages);
      if (!pending?.pendingId) return;
      autoResumedApprovalRef.current = pending.messageId;
      resumeHitl(
        pending.actions.map(() => ({ type: "approve" })),
        threadId,
        undefined,
        policy,
        pending.pendingId,
      );
    },
    [unavailable, messages, resumeHitl, threadId],
  );

  useEffect(() => {
    if (unavailable || isStreaming || historyLoading) return;
    const timer = window.setTimeout(() => {
      const pending = findAutoResumableApproval(
        hitlPolicy,
        chatStore.getSnapshot(threadId).messages,
      );
      if (!pending?.pendingId) {
        autoResumedApprovalRef.current = null;
        return;
      }
      if (autoResumedApprovalRef.current === pending.messageId) return;
      autoResumedApprovalRef.current = pending.messageId;
      resumeHitl(
        pending.actions.map(() => ({ type: "approve" })),
        threadId,
        undefined,
        hitlPolicy,
        pending.pendingId,
      );
    }, 50);
    return () => window.clearTimeout(timer);
  }, [
    unavailable,
    isStreaming,
    historyLoading,
    messages,
    hitlPolicy,
    resumeHitl,
    threadId,
  ]);

  const handleSend = useCallback(
    (text: string, attachments?: ChatAttachment[]) => {
      if (inputDisabled || isStreaming) return;
      const currentMessages = chatStore.getSnapshot(threadId).messages;
      const ask = findPendingAsk(currentMessages);
      if (ask) {
        if (attachments?.length) {
          setNotice(t("chat.sideChat.askAttachments"));
          return;
        }
        if (!text.trim()) return;
        resumeHitl(
          ask.actions.map(() => ({ type: "respond", message: text.trim() })),
          threadId,
        );
        setNotice(null);
        return;
      }
      if (hasPendingHitl(currentMessages)) {
        setNotice(t("chat.sideChat.finishPendingFirst"));
        return;
      }
      if (!text.trim() && !attachments?.length) return;
      setNotice(null);
      sendMessage(
        text,
        thread.session_key,
        agentId,
        attachments,
        threadId,
        selectedModel,
        undefined,
        undefined,
        undefined,
        buildComposerContext({
          selectedModel,
          reasoningMode: reasoning.mode,
          reasoningEffort: reasoning.effort,
        }),
        reasoning.mode,
        reasoning.effort,
        conversationMode,
        hitlPolicy,
        thread.session_mode,
      );
    },
    [
      inputDisabled,
      isStreaming,
      threadId,
      resumeHitl,
      t,
      sendMessage,
      thread.session_key,
      thread.session_mode,
      agentId,
      selectedModel,
      reasoning,
      conversationMode,
      hitlPolicy,
    ],
  );

  return (
    <aside className={styles.panel} aria-label={t("chat.sideChat.title")}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <MessageSquare size={18} aria-hidden="true" />
          <h2>{t("chat.sideChat.title")}</h2>
        </div>
        <div className={styles.actions}>
          <Button
            size="small"
            icon={<Save size={14} />}
            autoInsertSpace={false}
            aria-label={t("chat.sideChat.save")}
            loading={saving}
            disabled={
              disabled ||
              saving ||
              isStreaming ||
              pendingHitl ||
              historyLoading ||
              historyError
            }
            onClick={() => void onPersist()}
          >
            {t("chat.sideChat.save")}
          </Button>
          {onHide && (
            <Button
              type="text"
              size="small"
              icon={<PanelRightClose size={17} />}
              aria-label={t("chat.sideChat.hide")}
              title={t("chat.sideChat.hide")}
              onClick={onHide}
            />
          )}
          <Button
            type="text"
            size="small"
            icon={<X size={18} />}
            aria-label={t("chat.sideChat.close")}
            disabled={saving}
            onClick={onClose}
          />
        </div>
      </header>
      <p className={styles.hint}>{t("chat.sideChat.temporaryHint")}</p>
      {historyError && (
        <Alert
          className={styles.notice}
          type="error"
          showIcon
          message={t("chat.sideChat.loadFailed")}
          action={
            <Button size="small" onClick={() => void retryHistory()}>
              {t("chat.sideChat.retry")}
            </Button>
          }
        />
      )}
      <div className={styles.messages}>
        <MessageList
          messages={messages}
          agentId={agentId}
          sessionKey={threadId}
          loading={historyLoading}
          historyHasMore={historyHasMore}
          historyLoadingMore={historyLoadingMore}
          historyRefreshing={historyRefreshing}
          onLoadMoreHistory={loadMoreHistory}
          onRefreshHistory={() => void refreshHistory(threadId)}
          isStreaming={isStreaming}
          liveSpeakers={liveSpeakers}
          thinkingStartedAt={thinkingStartedAt}
          onHitlDecision={unavailable ? undefined : handleHitlDecision}
          compactProcess
        />
      </div>
      {notice && (
        <Alert
          className={styles.notice}
          type="info"
          message={notice}
          showIcon
        />
      )}
      {pendingAsk && (
        <div className={styles.question}>
          <AskQuestionCard
            key={pendingAsk.messageId}
            questions={pendingAsk.questions}
            status="pending"
            docked
            onSubmit={
              unavailable
                ? undefined
                : (answer) =>
                    handleHitlDecision(
                      pendingAsk.actions.map(() => ({
                        type: "respond",
                        message: answer,
                      })),
                    )
            }
            onDismiss={
              unavailable
                ? undefined
                : () => {
                    resumeHitl(
                      pendingAsk.actions.map(() => ({
                        type: "respond",
                        message: t("chat.sideChat.dismissMessage"),
                      })),
                      threadId,
                      true,
                    );
                  }
            }
          />
        </div>
      )}
      <div className={styles.composer}>
        <ChatInput
          active={active}
          agentId={agentId}
          threadId={threadId}
          onSend={handleSend}
          onCancel={() => {
            if (!unavailable) cancelStream();
          }}
          onNewChat={() => onHide?.()}
          isStreaming={isStreaming}
          disabled={inputDisabled || (pendingHitl && !pendingAsk)}
          availableModels={availableModels}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          reasoningMode={reasoning.mode}
          reasoningEffort={reasoning.effort}
          onReasoningChange={(mode, effort) => setReasoning({ mode, effort })}
          conversationMode={conversationMode}
          onConversationModeChange={setConversationMode}
          sessionMode={thread.session_mode ?? undefined}
          hitlPolicy={hitlPolicy}
          onHitlPolicyChange={handlePolicyChange}
          lockThreadSettings={unavailable}
        />
      </div>
    </aside>
  );
}
