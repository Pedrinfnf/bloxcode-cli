// ═══════════════════════════════════════════════════════════════════════════════
// BLOXCODE TUI — Rust ratatui terminal UI
// Handles ALL rendering and input. Talks to TS backend via JSON over stdio.
//
// Architecture:
//   [User] ←→ [Rust TUI (raw mode, panels, menus)] ←→ [TS Agent (LLM, tools)]
//
// The TS agent runs as a child process. Communication is JSON lines over
// stdin/stdout. The Rust TUI owns the terminal completely.
// ═══════════════════════════════════════════════════════════════════════════════

use std::io;
use std::time::Duration;
use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    execute,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect, Margin},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span, Text},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap, Clear, Scrollbar, ScrollbarOrientation, ScrollbarState},
    Frame, Terminal,
};

// ═══════════════════════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════════════════════

struct App {
    input: String,
    cursor: usize,
    messages: Vec<Msg>,
    scroll: usize,
    mode: AppMode,
    commands: Vec<Cmd>,
    cmd_selected: usize,
    cmd_filter: String,
    model: String,
    status: String,
    should_quit: bool,
}

struct Msg {
    role: String,
    content: String,
}

struct Cmd {
    name: String,
    desc: String,
}

#[derive(PartialEq)]
enum AppMode {
    Normal,
    CommandPalette, // / was pressed — show command list
}

impl App {
    fn new() -> Self {
        let commands = vec![
            Cmd { name: "/help".into(), desc: "Show commands".into() },
            Cmd { name: "/model".into(), desc: "Switch model".into() },
            Cmd { name: "/api set".into(), desc: "Set API key".into() },
            Cmd { name: "/api show".into(), desc: "Show API key".into() },
            Cmd { name: "/mode".into(), desc: "Change mode".into() },
            Cmd { name: "/agent".into(), desc: "Multi-agent".into() },
            Cmd { name: "/tools".into(), desc: "List tools".into() },
            Cmd { name: "/mcp".into(), desc: "MCP status".into() },
            Cmd { name: "/mcp add".into(), desc: "Add MCP server".into() },
            Cmd { name: "/clear".into(), desc: "Clear context".into() },
            Cmd { name: "/exit".into(), desc: "Quit".into() },
        ];

        Self {
            input: String::new(),
            cursor: 0,
            messages: vec![Msg {
                role: "system".into(),
                content: "Welcome to BloxCode. Type /help or start chatting.".into(),
            }],
            scroll: 0,
            mode: AppMode::Normal,
            commands,
            cmd_selected: 0,
            cmd_filter: String::new(),
            model: "nemotron-ultra-550b".into(),
            status: "ready".into(),
            should_quit: false,
        }
    }

    fn filtered_commands(&self) -> Vec<&Cmd> {
        if self.cmd_filter.is_empty() {
            self.commands.iter().collect()
        } else {
            let f = self.cmd_filter.to_lowercase();
            self.commands.iter().filter(|c| c.name.to_lowercase().contains(&f) || c.desc.to_lowercase().contains(&f)).collect()
        }
    }

    fn submit_input(&mut self) {
        let input = self.input.trim().to_string();
        if input.is_empty() { return; }

        self.messages.push(Msg { role: "user".into(), content: input.clone() });
        self.input.clear();
        self.cursor = 0;
        self.mode = AppMode::Normal;

        if input == "/exit" || input == "/quit" {
            self.should_quit = true;
            return;
        }

        if input == "/help" {
            let help = self.commands.iter().map(|c| format!("  {} — {}", c.name, c.desc)).collect::<Vec<_>>().join("\n");
            self.messages.push(Msg { role: "system".into(), content: help });
            return;
        }

        if input == "/clear" {
            self.messages.clear();
            self.messages.push(Msg { role: "system".into(), content: "Cleared.".into() });
            return;
        }

        // TODO: send to TS backend via IPC
        self.messages.push(Msg {
            role: "assistant".into(),
            content: format!("[TUI mode — TS backend integration coming]\nYou said: {}", input),
        });
        self.scroll_to_bottom();
    }

    fn scroll_to_bottom(&mut self) {
        let total_lines: usize = self.messages.iter().map(|m| m.content.lines().count() + 1).sum();
        self.scroll = total_lines.saturating_sub(10);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

fn ui(f: &mut Frame, app: &App) {
    let area = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),     // header
            Constraint::Min(1),        // chat
            Constraint::Length(3),     // input
            Constraint::Length(1),     // status
        ])
        .split(area);

    render_header(f, chunks[0], app);
    render_chat(f, chunks[1], app);
    render_input(f, chunks[2], app);
    render_status(f, chunks[3], app);

    // Command palette overlay
    if app.mode == AppMode::CommandPalette {
        render_command_palette(f, area, app);
    }
}

fn render_header(f: &mut Frame, area: Rect, app: &App) {
    let header = Line::from(vec![
        Span::styled(" ● ", Style::default().fg(Color::Cyan).bold()),
        Span::styled("bloxcode", Style::default().fg(Color::Cyan).bold()),
        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
        Span::styled(&app.model, Style::default().fg(Color::Yellow)),
    ]);
    f.render_widget(Paragraph::new(header), area);
}

fn render_chat(f: &mut Frame, area: Rect, app: &App) {
    let mut items: Vec<ListItem> = Vec::new();

    for msg in &app.messages {
        let (prefix, style) = match msg.role.as_str() {
            "user" => ("you ", Style::default().fg(Color::White)),
            "assistant" => ("ai  ", Style::default().fg(Color::Cyan)),
            "system" => ("sys ", Style::default().fg(Color::DarkGray)),
            _ => ("??? ", Style::default()),
        };

        for (i, line) in msg.content.lines().enumerate() {
            let p = if i == 0 { prefix } else { "    " };
            items.push(ListItem::new(Line::from(vec![
                Span::styled(p, style.add_modifier(Modifier::BOLD)),
                Span::styled(line, style),
            ])));
        }
        items.push(ListItem::new(Line::from(""))); // gap
    }

    let list = List::new(items)
        .block(Block::default().borders(Borders::NONE));
    f.render_widget(list, area);
}

fn render_input(f: &mut Frame, area: Rect, app: &App) {
    let input_text = Line::from(vec![
        Span::styled(" > ", Style::default().fg(Color::Green).bold()),
        Span::raw(&app.input),
        Span::styled("█", Style::default().fg(Color::Cyan)),
    ]);
    let input = Paragraph::new(input_text)
        .block(Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(Color::DarkGray)));
    f.render_widget(input, area);
}

fn render_status(f: &mut Frame, area: Rect, app: &App) {
    let bar = Line::from(vec![
        Span::styled(" /", Style::default().fg(Color::DarkGray)),
        Span::styled("commands", Style::default().fg(Color::DarkGray)),
        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
        Span::styled("@", Style::default().fg(Color::DarkGray)),
        Span::styled("file", Style::default().fg(Color::DarkGray)),
        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
        Span::styled("!", Style::default().fg(Color::DarkGray)),
        Span::styled("shell", Style::default().fg(Color::DarkGray)),
        Span::styled("        ", Style::default()),
        Span::styled(&app.status, Style::default().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(bar), area);
}

fn render_command_palette(f: &mut Frame, area: Rect, app: &App) {
    let filtered = app.filtered_commands();
    let height = (filtered.len() + 4).min(15) as u16;
    let width = 40.min(area.width.saturating_sub(4));

    // Position above the input area
    let x = 2;
    let y = area.height.saturating_sub(height + 4);
    let popup = Rect::new(x, y, width, height);

    f.render_widget(Clear, popup);

    let items: Vec<ListItem> = filtered.iter().enumerate().map(|(i, cmd)| {
        let style = if i == app.cmd_selected {
            Style::default().fg(Color::White).bg(Color::DarkGray).bold()
        } else {
            Style::default().fg(Color::White)
        };
        let pointer = if i == app.cmd_selected { "▸ " } else { "  " };
        ListItem::new(Line::from(vec![
            Span::styled(pointer, Style::default().fg(Color::Cyan)),
            Span::styled(&cmd.name, style),
            Span::styled(format!("  {}", cmd.desc), Style::default().fg(Color::DarkGray)),
        ]))
    }).collect();

    let list = List::new(items)
        .block(Block::default()
            .title(" commands ")
            .title_style(Style::default().fg(Color::Cyan).bold())
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan)));
    f.render_widget(list, popup);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

fn handle_event(app: &mut App) -> Result<bool> {
    if !event::poll(Duration::from_millis(50))? {
        return Ok(false);
    }

    if let Event::Key(key) = event::read()? {
        if key.kind != KeyEventKind::Press { return Ok(false); }

        // Ctrl+C always quits
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            app.should_quit = true;
            return Ok(true);
        }

        match app.mode {
            AppMode::Normal => handle_normal(app, key.code),
            AppMode::CommandPalette => handle_command_palette(app, key.code),
        }
    }
    Ok(false)
}

fn handle_normal(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char(c) => {
            app.input.insert(app.cursor, c);
            app.cursor += 1;
            // Auto-open command palette when typing /
            if app.input == "/" {
                app.mode = AppMode::CommandPalette;
                app.cmd_selected = 0;
                app.cmd_filter.clear();
            }
        }
        KeyCode::Backspace => {
            if app.cursor > 0 {
                app.cursor -= 1;
                app.input.remove(app.cursor);
            }
        }
        KeyCode::Enter => app.submit_input(),
        KeyCode::Left => { if app.cursor > 0 { app.cursor -= 1; } }
        KeyCode::Right => { if app.cursor < app.input.len() { app.cursor += 1; } }
        KeyCode::Up => { app.scroll = app.scroll.saturating_sub(1); }
        KeyCode::Down => { app.scroll += 1; }
        KeyCode::Esc => { app.input.clear(); app.cursor = 0; }
        _ => {}
    }
}

fn handle_command_palette(app: &mut App, key: KeyCode) {
    let filtered_len = app.filtered_commands().len();
    match key {
        KeyCode::Up => {
            app.cmd_selected = app.cmd_selected.saturating_sub(1);
        }
        KeyCode::Down => {
            if app.cmd_selected + 1 < filtered_len {
                app.cmd_selected += 1;
            }
        }
        KeyCode::Enter => {
            let selected_name = {
                let filtered = app.filtered_commands();
                filtered.get(app.cmd_selected).map(|c| c.name.clone())
            };
            if let Some(name) = selected_name {
                let auto_submit = name == "/exit" || name == "/help" || name == "/clear" || name == "/tools" || name == "/mcp";
                app.input = name;
                if auto_submit {
                    app.cursor = app.input.len();
                    app.mode = AppMode::Normal;
                    app.submit_input();
                } else {
                    app.input.push(' ');
                    app.cursor = app.input.len();
                    app.mode = AppMode::Normal;
                }
            }
        }
        KeyCode::Esc => {
            app.mode = AppMode::Normal;
            app.input.clear();
            app.cursor = 0;
        }
        KeyCode::Backspace => {
            if app.input.len() <= 1 {
                app.mode = AppMode::Normal;
                app.input.clear();
                app.cursor = 0;
            } else {
                app.cursor = app.cursor.saturating_sub(1);
                if app.cursor < app.input.len() { app.input.remove(app.cursor); }
                app.cmd_filter = app.input[1..].to_string();
                app.cmd_selected = 0;
            }
        }
        KeyCode::Char(c) => {
            app.input.insert(app.cursor, c);
            app.cursor += 1;
            app.cmd_filter = app.input[1..].to_string();
            app.cmd_selected = 0;
        }
        _ => {}
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::main]
async fn main() -> Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();

    // Main loop
    loop {
        terminal.draw(|f| ui(f, &app))?;
        handle_event(&mut app)?;
        if app.should_quit { break; }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    println!("\n  ● goodbye\n");
    Ok(())
}
