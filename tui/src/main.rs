// ═══════════════════════════════════════════════════════════════════════════════
// BLOXCODE TUI v0.1.2 — Connected to TS backend via IPC
// Real chat, real model selector, real tool calls
// ═══════════════════════════════════════════════════════════════════════════════

use std::io::{self, BufRead, BufReader, Write};
use std::process::{Command, Stdio, Child};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    execute,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Clear, Wrap},
    Frame, Terminal,
};

// ═══════════════════════════════════════════════════════════════════════════════
// IPC
// ═══════════════════════════════════════════════════════════════════════════════

struct Backend {
    child: Child,
    tx: mpsc::Sender<String>,
}

impl Backend {
    fn start() -> Result<(Self, mpsc::Receiver<serde_json::Value>)> {
        // Find the TS ipc script relative to the binary
        let exe = std::env::current_exe().unwrap_or_default();
        let pkg_root = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).unwrap_or(std::path::Path::new("."));
        let ipc_script = pkg_root.join("src/ipc.ts");

        let tsx = pkg_root.join("node_modules/.bin/tsx");
        let tsx_path = if tsx.exists() { tsx.to_str().unwrap().to_string() } else { "npx".to_string() };
        let mut args = vec![];
        if tsx_path == "npx" { args.push("tsx".to_string()); }
        args.push(ipc_script.to_str().unwrap_or("src/ipc.ts").to_string());

        let mut child = Command::new(&tsx_path)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let stdout = child.stdout.take().unwrap();
        let (msg_tx, msg_rx) = mpsc::channel();

        // Read thread — receives JSON lines from TS backend
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        let _ = msg_tx.send(val);
                    }
                }
            }
        });

        let (cmd_tx, cmd_rx) = mpsc::channel::<String>();
        let mut stdin = child.stdin.take().unwrap();

        // Write thread — sends commands to TS backend
        thread::spawn(move || {
            while let Ok(cmd) = cmd_rx.recv() {
                let _ = writeln!(stdin, "{}", cmd);
                let _ = stdin.flush();
            }
        });

        Ok((Backend { child, tx: cmd_tx }, msg_rx))
    }

    fn send(&self, cmd: &serde_json::Value) {
        let _ = self.tx.send(serde_json::to_string(cmd).unwrap());
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Clone)]
struct Msg { role: String, content: String }

#[derive(Clone)]
struct ModelItem { id: String, name: String, ctx: u64, free: bool }

#[derive(PartialEq, Clone)]
enum Mode { Normal, CommandPalette, ModelSelector, ApiSetup }

struct App {
    input: String,
    cursor: usize,
    messages: Vec<Msg>,
    mode: Mode,
    model: String,
    provider: String,
    status: String,
    streaming: String,      // accumulates streamed text
    is_streaming: bool,
    credits: Option<String>, // e.g. "46/50"
    // Command palette
    commands: Vec<(String, String)>,
    cmd_selected: usize,
    // Model selector
    models: Vec<ModelItem>,
    model_selected: usize,
    model_filter: String,
    // API setup
    providers_list: Vec<(String, String)>, // (id, name)
    api_step: u8, // 0=choose provider, 1=paste key, 2=test
    api_provider_selected: usize,
    api_key_input: String,
    should_quit: bool,
}

impl App {
    fn new() -> Self {
        Self {
            input: String::new(), cursor: 0,
            messages: vec![Msg { role: "system".into(), content: "Starting backend...".into() }],
            mode: Mode::Normal, model: "loading...".into(), provider: "openrouter".into(),
            status: "connecting".into(), streaming: String::new(), is_streaming: false,
            credits: None,
            commands: vec![
                ("/help".into(), "Show commands".into()),
                ("/model".into(), "Switch model".into()),
                ("/api".into(), "Setup API provider + key".into()),
                ("/agent".into(), "Multi-agent orchestrator".into()),
                ("/tools".into(), "List all tools".into()),
                ("/mcp".into(), "MCP status".into()),
                ("/clear".into(), "Clear context".into()),
                ("/reasoning".into(), "Toggle reasoning".into()),
                ("/exit".into(), "Quit".into()),
            ],
            cmd_selected: 0,
            models: vec![], model_selected: 0, model_filter: String::new(),
            providers_list: vec![
                ("openrouter".into(), "OpenRouter (multi-model, free tier)".into()),
                ("openai".into(), "OpenAI (GPT-5, o3)".into()),
                ("anthropic".into(), "Anthropic (Claude)".into()),
                ("google".into(), "Google Gemini".into()),
                ("groq".into(), "Groq (fast, free)".into()),
                ("deepseek".into(), "DeepSeek".into()),
                ("xai".into(), "xAI (Grok)".into()),
                ("mistral".into(), "Mistral AI".into()),
                ("together".into(), "Together AI".into()),
                ("cerebras".into(), "Cerebras (fast, free)".into()),
                ("cohere".into(), "Cohere".into()),
                ("ollama".into(), "Ollama (local)".into()),
                ("lmstudio".into(), "LM Studio (local)".into()),
                ("custom".into(), "Custom OpenAI-compatible".into()),
            ],
            api_step: 0, api_provider_selected: 0, api_key_input: String::new(),
            should_quit: false,
        }
    }

    fn filtered_commands(&self) -> Vec<(usize, &(String, String))> {
        let filter = if self.input.len() > 1 { self.input[1..].to_lowercase() } else { String::new() };
        self.commands.iter().enumerate()
            .filter(|(_, c)| filter.is_empty() || c.0.to_lowercase().contains(&filter) || c.1.to_lowercase().contains(&filter))
            .collect()
    }

    fn filtered_models(&self) -> Vec<&ModelItem> {
        if self.model_filter.is_empty() { self.models.iter().collect() }
        else { let f = self.model_filter.to_lowercase(); self.models.iter().filter(|m| m.id.to_lowercase().contains(&f) || m.name.to_lowercase().contains(&f)).collect() }
    }

    fn add_msg(&mut self, role: &str, content: &str) {
        self.messages.push(Msg { role: role.into(), content: content.into() });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════

fn ui(f: &mut Frame, app: &App) {
    let chunks = Layout::default().direction(Direction::Vertical).constraints([
        Constraint::Length(1), Constraint::Min(1), Constraint::Length(3), Constraint::Length(1),
    ]).split(f.area());

    // Header
    let cred = app.credits.as_deref().unwrap_or("");
    let header = Line::from(vec![
        Span::styled(" ● ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::styled("bloxcode", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
        Span::styled(&app.model, Style::default().fg(Color::Yellow)),
        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
        Span::styled(&app.provider, Style::default().fg(Color::Green)),
        Span::styled(if cred.is_empty() { String::new() } else { format!(" · {}", cred) }, Style::default().fg(Color::Magenta)),
    ]);
    f.render_widget(Paragraph::new(header), chunks[0]);

    // Chat
    let mut items: Vec<ListItem> = Vec::new();
    for msg in &app.messages {
        let (prefix, style) = match msg.role.as_str() {
            "user" => (" you ", Style::default().fg(Color::White)),
            "assistant" | "ai" => ("  ai ", Style::default().fg(Color::Cyan)),
            "tool" => ("tool ", Style::default().fg(Color::Yellow)),
            _ => (" sys ", Style::default().fg(Color::DarkGray)),
        };
        for (i, line) in msg.content.lines().enumerate() {
            let p = if i == 0 { prefix } else { "     " };
            items.push(ListItem::new(Line::from(vec![
                Span::styled(p, style.add_modifier(Modifier::BOLD)),
                Span::styled(line, style),
            ])));
        }
    }
    // Streaming text
    if app.is_streaming && !app.streaming.is_empty() {
        for (i, line) in app.streaming.lines().enumerate() {
            let p = if i == 0 { "  ai " } else { "     " };
            items.push(ListItem::new(Line::from(vec![
                Span::styled(p, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                Span::styled(line, Style::default().fg(Color::Cyan)),
            ])));
        }
        items.push(ListItem::new(Line::from(Span::styled("  ▊", Style::default().fg(Color::Cyan)))));
    }
    f.render_widget(List::new(items), chunks[1]);

    // Input
    let input_line = Line::from(vec![
        Span::styled(" > ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        Span::raw(&app.input), Span::styled("█", Style::default().fg(Color::Cyan)),
    ]);
    f.render_widget(
        Paragraph::new(input_line).block(Block::default().borders(Borders::TOP).border_style(Style::default().fg(Color::DarkGray))),
        chunks[2]
    );

    // Status
    let status = Line::from(vec![
        Span::styled(format!(" {} ", app.status), Style::default().fg(Color::DarkGray)),
        Span::styled("  /cmd · @file · !shell · ctrl+c quit", Style::default().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(status), chunks[3]);

    // Overlays
    match &app.mode {
        Mode::CommandPalette => render_cmd_palette(f, f.area(), app),
        Mode::ModelSelector => render_model_selector(f, f.area(), app),
        Mode::ApiSetup => render_api_setup(f, f.area(), app),
        _ => {}
    }
}

fn render_cmd_palette(f: &mut Frame, area: Rect, app: &App) {
    let filtered = app.filtered_commands();
    let h = (filtered.len() + 3).min(14) as u16;
    let w = 44.min(area.width - 2);
    let popup = Rect::new(1, area.height.saturating_sub(h + 4), w, h);
    f.render_widget(Clear, popup);
    let items: Vec<ListItem> = filtered.iter().map(|(_, cmd)| {
        let sel = app.commands.iter().position(|c| c.0 == cmd.0).unwrap_or(99) == app.cmd_selected;
        let s = if sel { Style::default().fg(Color::White).bg(Color::DarkGray).add_modifier(Modifier::BOLD) } else { Style::default() };
        ListItem::new(Line::from(vec![
            Span::styled(if sel { "▸ " } else { "  " }, Style::default().fg(Color::Cyan)),
            Span::styled(&cmd.0, s), Span::styled(format!("  {}", cmd.1), Style::default().fg(Color::DarkGray)),
        ]))
    }).collect();
    f.render_widget(List::new(items).block(Block::default().title(" commands ").title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)).borders(Borders::ALL).border_style(Style::default().fg(Color::Cyan))), popup);
}

fn render_model_selector(f: &mut Frame, area: Rect, app: &App) {
    let filtered = app.filtered_models();
    let h = (filtered.len() + 4).min(20) as u16;
    let w = (area.width - 4).min(60);
    let popup = Rect::new(2, 2, w, h);
    f.render_widget(Clear, popup);
    let items: Vec<ListItem> = filtered.iter().enumerate().map(|(i, m)| {
        let sel = i == app.model_selected;
        let s = if sel { Style::default().fg(Color::White).bg(Color::DarkGray).add_modifier(Modifier::BOLD) } else { Style::default() };
        let tag = if m.free { Span::styled(" [FREE]", Style::default().fg(Color::Green)) } else { Span::raw("") };
        ListItem::new(Line::from(vec![
            Span::styled(if sel { "▸ " } else { "  " }, Style::default().fg(Color::Cyan)),
            Span::styled(&m.name, s), Span::styled(format!("  ctx:{}k", m.ctx / 1000), Style::default().fg(Color::DarkGray)), tag,
        ]))
    }).collect();
    let title = if app.model_filter.is_empty() { " models ".to_string() } else { format!(" models — \"{}\" ", app.model_filter) };
    f.render_widget(List::new(items).block(Block::default().title(title).title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)).borders(Borders::ALL).border_style(Style::default().fg(Color::Cyan))), popup);
}

fn render_api_setup(f: &mut Frame, area: Rect, app: &App) {
    let w = (area.width - 4).min(50);
    let h = if app.api_step == 0 { (app.providers_list.len() + 3).min(18) as u16 } else { 8 };
    let popup = Rect::new(2, 2, w, h);
    f.render_widget(Clear, popup);

    if app.api_step == 0 {
        let items: Vec<ListItem> = app.providers_list.iter().enumerate().map(|(i, (id, name))| {
            let sel = i == app.api_provider_selected;
            let s = if sel { Style::default().fg(Color::White).bg(Color::DarkGray).add_modifier(Modifier::BOLD) } else { Style::default() };
            ListItem::new(Line::from(vec![
                Span::styled(if sel { "▸ " } else { "  " }, Style::default().fg(Color::Cyan)),
                Span::styled(id, s), Span::styled(format!("  {}", name), Style::default().fg(Color::DarkGray)),
            ]))
        }).collect();
        f.render_widget(List::new(items).block(Block::default().title(" choose provider ").title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)).borders(Borders::ALL).border_style(Style::default().fg(Color::Cyan))), popup);
    } else {
        let lines = vec![
            Line::from(Span::styled("  paste your API key:", Style::default().fg(Color::White))),
            Line::from(""),
            Line::from(vec![Span::styled("  > ", Style::default().fg(Color::Green)), Span::raw(&app.api_key_input), Span::styled("█", Style::default().fg(Color::Cyan))]),
            Line::from(""),
            Line::from(Span::styled("  Enter to save · Esc to cancel", Style::default().fg(Color::DarkGray))),
        ];
        f.render_widget(Paragraph::new(lines).block(Block::default().title(format!(" {} API key ", app.providers_list.get(app.api_provider_selected).map(|p| p.0.as_str()).unwrap_or("?"))).title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)).borders(Borders::ALL).border_style(Style::default().fg(Color::Cyan))), popup);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

fn main() -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let mut app = App::new();

    // Start TS backend
    let (backend, rx) = match Backend::start() {
        Ok(b) => b,
        Err(e) => {
            disable_raw_mode()?;
            execute!(io::stdout(), LeaveAlternateScreen)?;
            eprintln!("Failed to start backend: {}", e);
            eprintln!("Make sure tsx and node are installed");
            return Ok(());
        }
    };

    // Request credits on start
    backend.send(&serde_json::json!({"cmd": "credits"}));

    loop {
        // Process backend messages (non-blocking)
        while let Ok(msg) = rx.try_recv() {
            let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match t {
                "ready" => {
                    app.status = "ready".into();
                    app.model = msg.get("model").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                    app.provider = msg.get("provider").and_then(|v| v.as_object()).and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or("?").to_string();
                    app.messages.clear();
                    app.add_msg("system", &format!("Connected to {}. Type /help or start chatting.", app.provider));
                }
                "stream" => {
                    app.is_streaming = true;
                    app.status = "streaming".into();
                    if let Some(chunk) = msg.get("chunk").and_then(|v| v.as_str()) {
                        app.streaming.push_str(chunk);
                    }
                }
                "stream_end" | "response" => {
                    if t == "response" {
                        if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                            if app.is_streaming {
                                app.streaming.push_str(content);
                            } else {
                                app.add_msg("ai", content);
                            }
                        }
                    }
                }
                "done" => {
                    if app.is_streaming {
                        let text = std::mem::take(&mut app.streaming);
                        if !text.is_empty() { app.add_msg("ai", &text); }
                    }
                    app.is_streaming = false;
                    app.status = "ready".into();
                }
                "reasoning" => {
                    if let Some(r) = msg.get("content").and_then(|v| v.as_str()) {
                        if !r.is_empty() { app.add_msg("system", &format!("💭 {}", &r[..r.len().min(200)])); }
                    }
                }
                "tool_call" => {
                    let tool = msg.get("tool").and_then(|v| v.as_str()).unwrap_or("?");
                    app.add_msg("tool", &format!("→ {}", tool));
                    app.status = format!("tool: {}", tool);
                }
                "tool_result" => {
                    let tool = msg.get("tool").and_then(|v| v.as_str()).unwrap_or("?");
                    let ok = msg.get("result").and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
                    app.add_msg("tool", &format!("{} {}", if ok { "✓" } else { "✗" }, tool));
                }
                "models" => {
                    if let Some(models) = msg.get("models").and_then(|v| v.as_array()) {
                        app.models = models.iter().map(|m| ModelItem {
                            id: m.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string(),
                            name: m.get("name").and_then(|v| v.as_str()).unwrap_or("?").to_string(),
                            ctx: m.get("context").and_then(|v| v.as_u64()).unwrap_or(0),
                            free: m.get("pricing").and_then(|v| v.get("input")).and_then(|v| v.as_f64()).unwrap_or(1.0) == 0.0,
                        }).collect();
                        app.mode = Mode::ModelSelector;
                        app.model_selected = 0;
                        app.model_filter.clear();
                    }
                }
                "credits" => {
                    if let Some(c) = msg.get("credits").and_then(|v| v.as_object()) {
                        let rem = c.get("remaining").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let lim = c.get("limit").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        if lim > 0.0 { app.credits = Some(format!("{:.0}/{:.0}", rem, lim)); }
                    }
                }
                "ok" => {
                    if let Some(m) = msg.get("msg").and_then(|v| v.as_str()) { app.add_msg("system", m); }
                }
                "error" => {
                    if let Some(m) = msg.get("msg").and_then(|v| v.as_str()) { app.add_msg("system", &format!("✗ {}", m)); }
                    app.is_streaming = false;
                    app.status = "error".into();
                }
                _ => {}
            }
        }

        terminal.draw(|f| ui(f, &app))?;

        if !event::poll(Duration::from_millis(30))? { continue; }
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press { continue; }
            if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) { app.should_quit = true; }

            match app.mode.clone() {
                Mode::Normal => match key.code {
                    KeyCode::Char(c) => {
                        app.input.insert(app.cursor, c); app.cursor += 1;
                        if app.input == "/" { app.mode = Mode::CommandPalette; app.cmd_selected = 0; }
                    }
                    KeyCode::Backspace => { if app.cursor > 0 { app.cursor -= 1; app.input.remove(app.cursor); } }
                    KeyCode::Enter => {
                        let input = app.input.trim().to_string();
                        app.input.clear(); app.cursor = 0;
                        if input.is_empty() { continue; }
                        if input == "/exit" || input == "/quit" { app.should_quit = true; continue; }
                        if input == "/clear" { backend.send(&serde_json::json!({"cmd":"clear"})); app.messages.clear(); continue; }
                        if input == "/model" { backend.send(&serde_json::json!({"cmd":"models"})); app.status = "loading models...".into(); continue; }
                        if input == "/api" { app.mode = Mode::ApiSetup; app.api_step = 0; app.api_provider_selected = 0; continue; }
                        if input == "/tools" { backend.send(&serde_json::json!({"cmd":"tools"})); continue; }
                        if input.starts_with("!") { let cmd = input[1..].trim(); backend.send(&serde_json::json!({"cmd":"exec","command":cmd})); app.add_msg("user", &format!("!{}", cmd)); continue; }
                        if input.starts_with("/agent ") { let task = input[7..].trim(); backend.send(&serde_json::json!({"cmd":"agent","task":task})); app.add_msg("user", &input); continue; }

                        app.add_msg("user", &input);
                        app.status = "thinking...".into();
                        app.is_streaming = false;
                        app.streaming.clear();
                        backend.send(&serde_json::json!({"cmd":"chat","content":input,"reasoning":"high"}));
                    }
                    KeyCode::Esc => { app.input.clear(); app.cursor = 0; }
                    _ => {}
                },
                Mode::CommandPalette => match key.code {
                    KeyCode::Up => { app.cmd_selected = app.cmd_selected.saturating_sub(1); }
                    KeyCode::Down => { if app.cmd_selected + 1 < app.filtered_commands().len() { app.cmd_selected += 1; } }
                    KeyCode::Enter => {
                        let name = app.filtered_commands().get(app.cmd_selected).map(|(_, c)| c.0.clone());
                        if let Some(name) = name {
                            app.input = name.clone(); app.cursor = app.input.len(); app.mode = Mode::Normal;
                            if ["/exit","/help","/clear","/tools","/model","/api","/mcp"].contains(&name.as_str()) {
                                // Simulate enter
                                let input = std::mem::take(&mut app.input); app.cursor = 0;
                                if input == "/exit" { app.should_quit = true; }
                                else if input == "/model" { backend.send(&serde_json::json!({"cmd":"models"})); app.status = "loading models...".into(); }
                                else if input == "/api" { app.mode = Mode::ApiSetup; app.api_step = 0; }
                                else if input == "/clear" { backend.send(&serde_json::json!({"cmd":"clear"})); app.messages.clear(); }
                                else if input == "/tools" { backend.send(&serde_json::json!({"cmd":"tools"})); }
                                else if input == "/mcp" { backend.send(&serde_json::json!({"cmd":"mcp_status"})); }
                            } else { app.input.push(' '); app.cursor = app.input.len(); }
                        }
                    }
                    KeyCode::Esc => { app.mode = Mode::Normal; app.input.clear(); app.cursor = 0; }
                    KeyCode::Backspace => {
                        if app.input.len() <= 1 { app.mode = Mode::Normal; app.input.clear(); app.cursor = 0; }
                        else { app.cursor -= 1; app.input.remove(app.cursor); }
                    }
                    KeyCode::Char(c) => { app.input.insert(app.cursor, c); app.cursor += 1; app.cmd_selected = 0; }
                    _ => {}
                },
                Mode::ModelSelector => match key.code {
                    KeyCode::Up => { app.model_selected = app.model_selected.saturating_sub(1); }
                    KeyCode::Down => { let max = app.filtered_models().len(); if app.model_selected + 1 < max { app.model_selected += 1; } }
                    KeyCode::Enter => {
                        let id = app.filtered_models().get(app.model_selected).map(|m| m.id.clone());
                        if let Some(id) = id {
                            backend.send(&serde_json::json!({"cmd":"set_model","model":id}));
                            app.model = id; app.mode = Mode::Normal;
                        }
                    }
                    KeyCode::Esc => { app.mode = Mode::Normal; }
                    KeyCode::Backspace => { app.model_filter.pop(); app.model_selected = 0; }
                    KeyCode::Char(c) => { app.model_filter.push(c); app.model_selected = 0; }
                    _ => {}
                },
                Mode::ApiSetup => {
                    if app.api_step == 0 {
                        match key.code {
                            KeyCode::Up => { app.api_provider_selected = app.api_provider_selected.saturating_sub(1); }
                            KeyCode::Down => { if app.api_provider_selected + 1 < app.providers_list.len() { app.api_provider_selected += 1; } }
                            KeyCode::Enter => { app.api_step = 1; app.api_key_input.clear(); }
                            KeyCode::Esc => { app.mode = Mode::Normal; }
                            _ => {}
                        }
                    } else {
                        match key.code {
                            KeyCode::Char(c) => { app.api_key_input.push(c); }
                            KeyCode::Backspace => { app.api_key_input.pop(); }
                            KeyCode::Enter => {
                                let prov_id = app.providers_list.get(app.api_provider_selected).map(|p| p.0.clone()).unwrap_or_default();
                                let key = app.api_key_input.clone();
                                backend.send(&serde_json::json!({"cmd":"set_provider","provider":prov_id,"key":key}));
                                app.provider = prov_id;
                                app.mode = Mode::Normal;
                                app.add_msg("system", "API configured. Fetching credits...");
                                backend.send(&serde_json::json!({"cmd":"credits"}));
                            }
                            KeyCode::Esc => { app.mode = Mode::Normal; }
                            _ => {}
                        }
                    }
                }
            }
        }

        if app.should_quit {
            backend.send(&serde_json::json!({"cmd":"quit"}));
            break;
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    println!("\n  ● goodbye\n");
    Ok(())
}
