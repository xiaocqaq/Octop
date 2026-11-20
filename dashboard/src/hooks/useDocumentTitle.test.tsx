import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { useChatDocumentTitle, useSiteDocumentTitle } from "./useDocumentTitle";

type ChatTitleProps = {
  threadId?: string | null;
  name?: string | null;
  sideChatTitle?: string;
  siteTitle: string;
};

function ChatTitle({
  threadId,
  name,
  sideChatTitle,
  siteTitle,
}: ChatTitleProps) {
  useChatDocumentTitle(name, siteTitle, threadId);
  return sideChatTitle ? <aside>{sideChatTitle}</aside> : null;
}

function AppTitle({
  threadId = "main-thread",
  name,
  sideChatTitle,
  inChat = true,
  translate = () => "Mxiao",
}: Omit<ChatTitleProps, "siteTitle"> & {
  inChat?: boolean;
  translate?: (key: string) => string;
}) {
  const siteTitle = translate("app.pageTitle");
  useSiteDocumentTitle(siteTitle);
  return inChat ? (
    <ChatTitle
      threadId={threadId}
      name={name}
      sideChatTitle={sideChatTitle}
      siteTitle={siteTitle}
    />
  ) : null;
}

it.each([undefined, null, "", "__pending__"])(
  "ignores a session title until the main thread has a real ID (%s)",
  (threadId) => {
    render(
      <ChatTitle
        threadId={threadId}
        name="Delayed side title"
        siteTitle="Mxiao"
      />,
    );
    expect(document.title).toBe("Mxiao");
  },
);

it("ignores a delayed side title during main creation and follows the bound main thread", () => {
  const { rerender } = render(
    <AppTitle threadId="__pending__" name="New Chat" />,
  );
  expect(document.title).toBe("Mxiao");
  rerender(
    <AppTitle
      threadId="__pending__"
      name="Delayed side title"
      sideChatTitle="Delayed side title"
    />,
  );
  expect(document.title).toBe("Mxiao");
  rerender(
    <AppTitle
      threadId="created-main-thread"
      name="Main conversation"
      sideChatTitle="Delayed side title"
    />,
  );
  expect(document.title).toBe("Main conversation");
});

it("uses the known title when the main ID binds without a name change", () => {
  const { rerender } = render(
    <AppTitle threadId="__pending__" name="Main conversation" />,
  );
  expect(document.title).toBe("Mxiao");
  rerender(
    <AppTitle threadId="created-main-thread" name="Main conversation" />,
  );
  expect(document.title).toBe("Main conversation");
});

it("shows a known main conversation title when the app first mounts", () => {
  render(<AppTitle name="Project planning" />);
  expect(document.title).toBe("Project planning");
});

it.each([
  ["switches", "Project planning", "Meeting notes"],
  ["is renamed", "Project planning", "Project kickoff"],
  ["receives an automatic title", "New Chat", "Travel agenda"],
])("updates the tab when the main conversation %s", (_, initial, next) => {
  const { rerender } = render(<AppTitle name={initial} />);
  rerender(<AppTitle name={next} />);
  expect(document.title).toBe(next);
});

it.each([undefined, null, "", "   ", "New Chat"])(
  "restores Mxiao for a main conversation with no title (%s)",
  (name) => {
    const { rerender } = render(<AppTitle name="Project planning" />);
    rerender(<AppTitle name={name} />);
    expect(document.title).toBe("Mxiao");
  },
);

it("sets the title when a chat mounts after the app shell", () => {
  const { rerender } = render(<AppTitle inChat={false} />);
  expect(document.title).toBe("Mxiao");
  rerender(<AppTitle name="Project planning" />);
  expect(document.title).toBe("Project planning");
});

it("restores the site title when the app and chat unmount together", () => {
  const { unmount } = render(<AppTitle name="Project planning" />);
  unmount();
  expect(document.title).toBe("Mxiao");
});

it("restores the site title on leaving the chat route", () => {
  const { rerender } = render(<AppTitle name="Project planning" />);
  rerender(<AppTitle inChat={false} />);
  expect(document.title).toBe("Mxiao");
});

it("keeps the conversation title when language changes with the same site name", () => {
  const english = () => "Mxiao";
  const chinese = () => "Mxiao";
  const { rerender } = render(
    <AppTitle name="Project planning" translate={english} />,
  );
  rerender(<AppTitle name="Project planning" translate={chinese} />);
  expect(document.title).toBe("Project planning");
});

it("keeps the main title when a side chat opens or changes its title", () => {
  const { rerender } = render(<AppTitle name="Project planning" />);
  rerender(<AppTitle name="Project planning" sideChatTitle="Side notes" />);
  expect(screen.getByText("Side notes")).toBeInTheDocument();
  expect(document.title).toBe("Project planning");
  rerender(<AppTitle name="Project planning" sideChatTitle="More notes" />);
  expect(screen.getByText("More notes")).toBeInTheDocument();
  expect(document.title).toBe("Project planning");
});
