"""Serial Chromium fixture checks; no production login or HTTP mutation."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
assert (ROOT / "clean-chat-ui/ui/dist/index.js").read_text(encoding="utf-8").strip() in (ROOT / "preview.html").read_text(encoding="utf-8")
CHIP = '[class*="__contextChipConnector__"], [class*="__contextChipKnowledge__"]'
MODEL = '[class*="__contextChipModel__"]'
SIDE_BUTTON = 'aside[class*="SideChatPanel-module__panel__"] button[class*="__newChatBtn__"]'
MAIN_BUTTON = 'section:first-child button[class*="__newChatBtn__"]'
STYLE = "#octop-clean-chat-ui-style"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1360, "height": 760}, device_scale_factor=1)
    page.goto((ROOT / "preview.html").as_uri())
    page.wait_for_function("typeof window.previewSetup === 'function'")
    results = []

    def check(name, ok):
        assert ok, name
        results.append(name)

    def visible(selector):
        locator = page.locator(selector)
        return locator.count() > 0 and locator.evaluate_all("els => els.every(e => e.getBoundingClientRect().height > 0)")

    def hidden(selector):
        locator = page.locator(selector)
        return locator.count() > 0 and locator.evaluate_all("els => els.every(e => e.getBoundingClientRect().height === 0)")

    def setup(catalog):
        page.evaluate("async catalog => {window.previewSetup({request:()=>Promise.resolve(catalog)});await Promise.resolve();}", catalog)

    def native():
        return visible(CHIP) and visible(MODEL) and visible(SIDE_BUTTON) and visible(MAIN_BUTTON)

    def optimized():
        return hidden(CHIP) and hidden(MODEL) and hidden(SIDE_BUTTON) and visible(MAIN_BUTTON)

    check("baseline targets exist and visible", page.locator(CHIP).count() == 10 and native())
    check("baseline composer and history model fixtures exist", page.locator(MODEL).count() == 4)
    page.screenshot(path=str(ROOT / "before.png"), full_page=True)
    page.locator("#toggle").click()
    page.wait_for_function("document.getElementById('octop-clean-chat-ui-style')?.textContent.length > 0")
    check("main and side MCP knowledge and model tags hidden", optimized())
    check("target-only composer and history rows collapsed", hidden('[class*="__imagePreviewBar__"], [class*="__userComposerTags__"]'))
    check("only side new conversation button hidden", hidden(SIDE_BUTTON) and visible(MAIN_BUTTON))
    check("side remaining composer controls visible", visible('aside .toolbar > button:not([class*="__newChatBtn__"])'))
    page.locator("textarea").first.fill("输入不会受影响")
    check("typing preserved", page.locator("textarea").count() == 2 and page.locator("textarea").first.input_value() == "输入不会受影响")
    page.locator("textarea").first.fill("")
    page.screenshot(path=str(ROOT / "after.png"), full_page=True)

    for index in range(2):
        page.locator(".add").nth(index).click()
        picker = page.locator(".picker").nth(index)
        check(f"resource picker preserved {index}", picker.is_visible() and picker.locator("input:checked").count() == 3)
        select = picker.locator("select")
        select.select_option("manual")
        check(f"model menu selection changes while composer chip stays hidden {index}", select.input_value() == "manual" and hidden(MODEL) and "手动模型" in page.locator('.composer [class*="__contextChipModel__"]').nth(index).text_content())
        select.select_option("auto")
        page.locator(".add").nth(index).click()

    page.evaluate("""() => {
      const box = document.createElement('div'); box.id = 'cases';
      box.innerHTML =
        '<div id="only" class="index-module__userComposerTags__other"><div class="index-module__contextChipModel__different">模型</div></div>' +
        '<div id="mixed" class="extra index-module__imagePreviewBar__different"><div class="extra index-module__contextChipKnowledge__different">KB</div><div id="mixed-model" class="index-module__contextChipModel__different">模型</div><span id="attachment">附件.pdf</span><span id="upload">上传中</span><span id="skill" class="index-module__contextChipSkill__different">技能</span><span id="expert" class="index-module__contextChipExpert__different">专家</span></div>' +
        '<div id="history-mixed" class="index-module__userComposerTags__different"><div id="history-model" class="index-module__contextChipModel__different">模型</div><span id="history-skill" class="index-module__contextChipSkill__different">技能</span></div>' +
        '<div id="outside" class="index-module__contextChipConnector__different">设置中的 MCP 不隐藏</div>' +
        '<div id="outside-model" class="index-module__contextChipModel__different">菜单内模型不隐藏</div>' +
        '<div id="similar" class="fakeindex-module__imagePreviewBar__different"><div class="index-module__contextChipConnector__different">不匹配相似类名</div></div>' +
        '<aside class="extra SideChatPanel-module__panel__changed"><button id="dynamic-button" class="extra index-module__newChatBtn__changed">新建</button><button id="save">保存</button><button id="hide">收起</button><button id="close">关闭</button></aside>' +
        '<aside class="fakeSideChatPanel-module__panel__changed"><button id="similar-side" class="index-module__newChatBtn__changed">保留</button></aside>' +
        '<aside class="SideChatPanel-module__panel__changed"><button id="similar-button" class="fakeindex-module__newChatBtn__changed">保留</button></aside>';
      document.body.append(box);
    }""")
    check("model-only history collapsed with changed hash", hidden("#only"))
    check("mixed row preserves attachments uploads skills experts", visible("#mixed, #attachment, #upload, #skill, #expert") and hidden("#mixed-model"))
    check("history mixed row preserves skills", visible("#history-mixed, #history-skill") and hidden("#history-model"))
    check("outside tags and similar classes untouched", visible("#outside, #outside-model, #similar > div, #similar-side, #similar-button"))
    check("dynamic side button hidden but header controls preserved", hidden("#dynamic-button") and visible("#save, #hide, #close"))
    page.evaluate("""() => {
      const row=document.createElement('div'); row.id='dynamic'; row.className='index-module__imagePreviewBar__new';
      row.innerHTML='<div class="index-module__contextChipModel__new">新切换模型</div>'; document.body.append(row);
    }""")
    check("newly mounted composer model hidden without observer", hidden("#dynamic"))
    for _ in range(3):
        setup([{"id": "clean-chat-ui", "enabled": True}])
    check("repeat setup uses one style", page.locator(STYLE).count() == 1)
    page.evaluate("""async () => {
      let resolve; window.previewSetup({request:()=>new Promise(r=>resolve=r)});
      window.previewSetup({request:()=>Promise.resolve([{id:'clean-chat-ui',enabled:false}])});
      await Promise.resolve();resolve([{id:'clean-chat-ui',enabled:true}]);await Promise.resolve();
    }""")
    check("stale enabled request cannot override newer disable", page.locator(STYLE).count() == 0 and native())
    page.evaluate("async () => {window.previewSetup({request:()=>Promise.reject(new Error('fixture network failure'))});await Promise.resolve();await Promise.resolve();}")
    check("request failure leaves native UI", page.locator(STYLE).count() == 0 and native())
    for catalog in [[], [{"id": "clean-chat-ui", "enabled": True, "error": "fixture load failure"}]]:
        setup(catalog)
        check("missing or errored plugin leaves native UI " + str(len(catalog)), native())
    page.locator("#cases").evaluate("e=>e.remove()")
    page.locator("#dynamic").evaluate("e=>e.remove()")
    setup([{"id": "clean-chat-ui", "enabled": True}])
    for width, theme, lang in [(390, "light", "zh"), (1360, "dark", "en")]:
        page.set_viewport_size({"width": width, "height": 844 if width == 390 else 760})
        page.evaluate("args=>{document.documentElement.dataset.theme=args[0];document.documentElement.lang=args[1]}", [theme, lang])
        check(f"selectors independent of viewport theme locale {width}/{theme}/{lang}", optimized())
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(ROOT / "mobile-after.png"), full_page=True)
    page.reload()
    page.wait_for_function("typeof window.previewSetup === 'function'")
    check("fresh page without setup restores tags and side button", native())
    browser.close()
    (ROOT / "browser-results.json").write_text(json.dumps({"passed": len(results), "checks": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(results), "checks": results}, ensure_ascii=False))
