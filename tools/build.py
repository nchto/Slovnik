"""Собирает обе версии Словника из исходников в корне репозитория.

- index.html          — сайт (GitHub Pages): разметка и стили из tools/shell.html,
                        скрипты подключаются отдельными файлами.
- tools/artifact.html — версия для claude.ai: тот же шаблон, core.js и ui.js
                        встроены в страницу.

Запуск из корня репозитория: python3 tools/build.py
Правите core.js, ui.js, cloud.js и tools/shell.html, затем запускаете сборку.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def write(text, *parts):
    with open(os.path.join(ROOT, *parts), "w", encoding="utf-8") as f:
        f.write(text)


shell = read("tools", "shell.html")
core = read("core.js")
ui = read("ui.js")

write(shell.replace("/*CORE*/", core).replace("/*UI*/", ui), "tools", "artifact.html")

HEAD = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#2f6b55">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Словник">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="description" content="Флешкарты для заучивания слов по алгоритму Anki">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
"""
SCRIPTS = """<script>window.SLOVNIK_LIBS = { jszip: "vendor/jszip.min.js", fzstd: "vendor/fzstd.js", sql: "vendor/sql-asm-memory-growth.js" };</script>
<script src="config.js"></script>
<script src="vendor/supabase.js"></script>
<script src="core.js"></script>
<script src="cloud.js"></script>
<script src="ui.js"></script>
<script>if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});</script>
</body>
</html>
"""
body = shell.split("<script>\n/*CORE*/")[0]
write(HEAD + body + SCRIPTS, "index.html")
print("Собрано: index.html и tools/artifact.html. Не забудьте поднять VERSION в sw.js, чтобы телефоны получили обновление.")
