import { useEffect, useLayoutEffect } from "react";

export function useSiteDocumentTitle(siteTitle: string) {
  // Establish the fallback before the active chat writes its title.
  useLayoutEffect(() => {
    document.title = siteTitle;
  }, [siteTitle]);
}

export function useChatDocumentTitle(
  name: string | null | undefined,
  siteTitle: string,
  threadId: string | null | undefined,
) {
  // Pending rows can receive a delayed rename from another thread.
  const title =
    threadId && threadId !== "__pending__" ? name?.trim() : undefined;
  useEffect(() => {
    // The sessions list uses "New Chat" until a thread has a title.
    document.title = title && title !== "New Chat" ? title : siteTitle;
    return () => {
      document.title = siteTitle;
    };
  }, [title, siteTitle]);
}
