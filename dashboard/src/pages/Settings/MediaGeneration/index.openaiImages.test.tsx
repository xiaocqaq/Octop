import { App } from "antd";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mediaGenerationApi,
  type MediaGenerationSettings,
  type MediaProviderPreset,
} from "../../../api/modules/mediaGeneration";
import { getProviderLogo } from "../../../assets/providers";
import en from "../../../locales/en.json";
import zh from "../../../locales/zh.json";
import MediaGenerationSettingsPanel from "./index";

vi.mock("../../../api/modules/mediaGeneration", () => ({
  mediaGenerationApi: {
    get: vi.fn(),
    getPresets: vi.fn(),
    save: vi.fn(),
    test: vi.fn(),
  },
}));

vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

const preset: MediaProviderPreset = {
  provider: "openai_images",
  display_name: "OpenAI Images (compatible)",
  base_url: "https://api.openai.com/v1",
  image_models: ["gpt-image-2"],
  video_models: [],
};

const settings: MediaGenerationSettings = {
  enabled: true,
  providers: [],
  default_image_provider: null,
  default_video_provider: null,
  configured: false,
};

const api = vi.mocked(mediaGenerationApi);
const getComputedStyle = window.getComputedStyle;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    getComputedStyle(element),
  );
  api.get.mockResolvedValue(settings);
  api.getPresets.mockResolvedValue([preset]);
  api.save.mockResolvedValue(settings);
});

function renderPanel() {
  return render(
    <App>
      <MediaGenerationSettingsPanel />
    </App>,
  );
}

describe("OpenAI Images provider", () => {
  it("keeps video controls for capable presets and resets video when switching providers", async () => {
    api.getPresets.mockResolvedValue([
      {
        provider: "volcengine",
        display_name: "Volcengine",
        base_url: "https://ark.example.test/api/v3",
        image_models: ["seedream"],
        video_models: ["seedance"],
      },
      preset,
    ]);
    renderPanel();
    fireEvent.click(await screen.findByText("Volcengine"));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByText("mediaGeneration.enableVideo")).toBeInTheDocument();
    expect(dialog.getByDisplayValue("seedance")).toBeInTheDocument();
    fireEvent.mouseDown(dialog.getByLabelText("mediaGeneration.providerType"));
    fireEvent.click(screen.getAllByText(preset.display_name).at(-1)!);

    expect(
      dialog.queryByText("mediaGeneration.enableVideo"),
    ).not.toBeInTheDocument();
    expect(
      dialog.queryByText("mediaGeneration.testVideoModel"),
    ).not.toBeInTheDocument();
    fireEvent.change(
      dialog.getByPlaceholderText("mediaGeneration.apiKeyPlaceholder"),
      {
        target: { value: "sk-test" },
      },
    );
    fireEvent.click(dialog.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          default_video_provider: null,
          providers: [
            expect.objectContaining({
              provider: "openai_images",
              image_model: "gpt-image-2",
              video_enabled: false,
              video_model: "",
            }),
          ],
        }),
      ),
    );
  });

  it("explains the /v1 API base URL in both locales", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText(preset.display_name));
    const dialog = within(await screen.findByRole("dialog"));

    expect(
      dialog.getByText("mediaGeneration.openaiImagesBaseUrlHint"),
    ).toBeInTheDocument();
    expect(en.mediaGeneration.openaiImagesBaseUrlHint).toContain("/v1");
    expect(zh.mediaGeneration.openaiImagesBaseUrlHint).toContain("/v1");
  });

  it("shows an image-only preset with the OpenAI logo", async () => {
    renderPanel();
    const logo = await screen.findByRole("img", { name: preset.display_name });

    expect(logo).toHaveAttribute("src", getProviderLogo("openai"));
    expect(screen.queryByText("mediaGeneration.video")).not.toBeInTheDocument();
  });

  it("disables stale video settings when editing an image-only provider", async () => {
    api.get.mockResolvedValue({
      ...settings,
      providers: [
        {
          id: "openai-images",
          provider: "openai_images",
          display_name: preset.display_name,
          enabled: true,
          base_url: preset.base_url,
          image_enabled: true,
          video_enabled: true,
          image_model: "custom-existing-model",
          video_model: "stale-video-model",
          api_key_set: true,
          configured: true,
        },
      ],
    });
    renderPanel();
    fireEvent.click(await screen.findByText(preset.display_name));
    const dialog = within(await screen.findByRole("dialog"));

    expect(
      dialog.queryByText("mediaGeneration.enableVideo"),
    ).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          default_video_provider: null,
          providers: [
            expect.objectContaining({
              provider: "openai_images",
              image_model: "custom-existing-model",
              video_enabled: false,
            }),
          ],
        }),
      ),
    );
  });

  it("creates an image-only provider using API preset defaults and accepts custom models", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText(preset.display_name));
    const dialog = within(await screen.findByRole("dialog"));

    expect(
      dialog.queryByText("mediaGeneration.enableVideo"),
    ).not.toBeInTheDocument();
    expect(
      dialog.queryByText("mediaGeneration.testVideoModel"),
    ).not.toBeInTheDocument();
    expect(dialog.getByDisplayValue("gpt-image-2")).toBeInTheDocument();
    expect(dialog.getByDisplayValue(preset.base_url)).toBeInTheDocument();
    fireEvent.change(dialog.getByDisplayValue("gpt-image-2"), {
      target: { value: "custom-image-model" },
    });
    fireEvent.change(
      dialog.getByPlaceholderText("mediaGeneration.apiKeyPlaceholder"),
      {
        target: { value: "sk-test" },
      },
    );
    fireEvent.click(dialog.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        enabled: true,
        default_video_provider: null,
        providers: [
          expect.objectContaining({
            provider: "openai_images",
            base_url: preset.base_url,
            image_model: "custom-image-model",
            image_enabled: true,
            video_model: "",
            video_enabled: false,
          }),
        ],
        default_image_provider: "openai_images-default",
      }),
    );
  });
});
