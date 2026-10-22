"""Sphinx configuration for the orch documentation."""

project = "orch"
author = "orch contributors"
copyright = "orch contributors, MIT license"

extensions = [
    "myst_parser",
    "sphinx_copybutton",
    "sphinx_design",
    "sphinxcontrib.mermaid",
]

source_suffix = {".md": "markdown"}
root_doc = "index"
exclude_patterns = ["_build", "requirements.txt", "Thumbs.db", ".DS_Store"]

myst_enable_extensions = ["colon_fence", "deflist"]
myst_heading_anchors = 3

html_theme = "furo"
html_title = "orch"
html_theme_options = {
    "source_repository": "https://github.com/Theroxat/claude_orch/",
    "source_branch": "main",
    "source_directory": "docs/",
}

copybutton_prompt_text = r"\$ "
copybutton_prompt_is_regexp = True
