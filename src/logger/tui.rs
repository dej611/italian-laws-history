//! Ratatui dashboard logger.
//!
//! Mirrors the operational UX of the TS blessed/blessed-contrib dashboard:
//! a list of recently-discovered acts, a decade breakdown by type, a
//! reference-count distribution, a type-share bar, a scrolling log, and a
//! status line. Pixels and exact widget styling are not required to match —
//! information density and update behavior are.
//!
//! The dashboard runs on its own tokio task; the `TuiLogger` `Logger` impl
//! sends messages over an unbounded mpsc channel and is `Send + Sync` for
//! free.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Stdout};
use std::time::Duration;

use chrono::Utc;
use crossterm::event::{self, Event, KeyCode};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Bar, BarChart, BarGroup, Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Terminal;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::git::checkout_main_sync_for_repo;
use crate::logger::{Logger, ShutdownSignal};
use crate::types::{ActVersionEntry, NormattivaAtto};

/// Channel messages from the logger (any thread) to the renderer task.
pub enum TuiMsg {
    Log(String),
    Status(String),
    UpdateList(Vec<NormattivaAtto>),
    UpdateRefs(String, u32),
    SeedCharts(HashMap<String, ActVersionEntry>),
    Shutdown,
}

pub struct TuiLogger {
    tx: mpsc::UnboundedSender<TuiMsg>,
}

impl Logger for TuiLogger {
    fn log(&self, msg: &str) {
        let _ = self.tx.send(TuiMsg::Log(msg.to_string()));
    }
    fn log_file(&self, _msg: &str) {}
    fn set_status(&self, status: &str) {
        let _ = self.tx.send(TuiMsg::Status(status.to_string()));
    }
    fn update_list(&self, items: &[NormattivaAtto]) {
        let _ = self.tx.send(TuiMsg::UpdateList(items.to_vec()));
    }
    fn seed_charts(&self, versions: &HashMap<String, ActVersionEntry>) {
        let _ = self.tx.send(TuiMsg::SeedCharts(versions.clone()));
    }
    fn update_refs(&self, codice: &str, refs: u32) {
        let _ = self.tx.send(TuiMsg::UpdateRefs(codice.to_string(), refs));
    }
    fn shutdown(&self) {
        let _ = self.tx.send(TuiMsg::Shutdown);
    }
}

/// Try to start the TUI. Returns `None` if the terminal isn't suitable
/// (not a TTY, too small, or any setup error). The CI logger is used as
/// fallback by `build_logger`.
pub async fn try_start(
    shutdown: ShutdownSignal,
    output_repo: String,
) -> Option<(TuiLogger, JoinHandle<()>)> {
    // Match the TS rule: width < 40 || height < 10 → fall back.
    let (cols, rows) = crossterm::terminal::size().ok()?;
    if cols < 40 || rows < 10 {
        return None;
    }

    let mut stdout = io::stdout();
    enable_raw_mode().ok()?;
    if execute!(stdout, EnterAlternateScreen).is_err() {
        let _ = disable_raw_mode();
        return None;
    }
    let backend = CrosstermBackend::new(stdout);
    let terminal = Terminal::new(backend).ok().or_else(|| {
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
        None
    })?;

    let shutdown_rx = shutdown.subscribe();
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(async move {
        if let Err(err) = run_loop(terminal, rx, shutdown_rx, output_repo).await {
            eprintln!("TUI loop error: {err}");
        }
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
    });

    Some((TuiLogger { tx }, handle))
}

const TYPE_COLORS: [Color; 6] = [
    Color::Cyan,
    Color::Green,
    Color::Yellow,
    Color::Magenta,
    Color::Red,
    Color::Blue,
];
const LOG_CAP: usize = 500;
const LIST_CAP: usize = 50;

#[derive(Default)]
struct State {
    seen_codes: std::collections::HashSet<String>,
    all_acts: Vec<NormattivaAtto>,
    ref_counts: HashMap<String, u32>,
    list_items: VecDeque<NormattivaAtto>,
    log: VecDeque<String>,
    status: String,
}

impl State {
    fn record_act(&mut self, act: &NormattivaAtto) {
        if self.seen_codes.insert(act.codice_redazionale.clone()) {
            self.all_acts.push(act.clone());
        }
    }

    fn top_types(&self) -> Vec<String> {
        let mut counts: HashMap<String, u32> = HashMap::new();
        for a in &self.all_acts {
            let t = a
                .denominazione_atto
                .clone()
                .unwrap_or_else(|| "ALTRO".to_string());
            *counts.entry(t).or_insert(0) += 1;
        }
        let mut sorted: Vec<(String, u32)> = counts.into_iter().collect();
        sorted.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        sorted
            .into_iter()
            .take(TYPE_COLORS.len())
            .map(|(k, _)| k)
            .collect()
    }

    fn decade_grid(&self, types: &[String]) -> Vec<(String, Vec<u32>)> {
        let mut grid: HashMap<String, HashMap<String, u32>> = HashMap::new();
        for a in &self.all_acts {
            let year = a
                .anno_provvedimento
                .clone()
                .or_else(|| a.data_gu.get(0..4).map(str::to_string));
            let Some(year) = year else { continue };
            if year.len() < 4 { continue; }
            let decade = format!("{}0", &year[0..3]);
            let t = a
                .denominazione_atto
                .clone()
                .unwrap_or_else(|| "ALTRO".to_string());
            let bucket = if types.iter().any(|x| x == &t) {
                t
            } else {
                "ALTRO".to_string()
            };
            *grid.entry(decade).or_default().entry(bucket).or_insert(0) += 1;
        }
        let mut sorted: Vec<(String, HashMap<String, u32>)> = grid.into_iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        sorted
            .into_iter()
            .rev()
            .take(15)
            .rev()
            .map(|(d, row)| {
                let row_vec: Vec<u32> =
                    types.iter().map(|t| row.get(t).copied().unwrap_or(0)).collect();
                (format!("{d}s"), row_vec)
            })
            .collect()
    }

    fn ref_distribution(&self, max_buckets: usize) -> Vec<(String, u32)> {
        let mut raw = [0u32; 11];
        for a in &self.all_acts {
            let r = self.ref_counts.get(&a.codice_redazionale).copied().unwrap_or(0);
            raw[r.min(10) as usize] += 1;
        }
        let last = max_buckets.saturating_sub(1).max(1);
        let mut buckets: Vec<u32> = raw[..last.min(raw.len())].to_vec();
        let tail: u32 = raw[last.min(raw.len())..].iter().copied().sum();
        buckets.push(tail);
        buckets
            .into_iter()
            .enumerate()
            .map(|(i, n)| {
                let label = if i + 1 < buckets_label_threshold(max_buckets) {
                    i.to_string()
                } else if i == max_buckets.saturating_sub(1) {
                    format!("{last}+")
                } else {
                    i.to_string()
                };
                (label, n)
            })
            .collect()
    }

    fn type_distribution(&self, types: &[String]) -> Vec<(String, u32, u32, Color)> {
        let mut counts: HashMap<String, u32> = HashMap::new();
        for a in &self.all_acts {
            let t = a
                .denominazione_atto
                .clone()
                .unwrap_or_else(|| "ALTRO".to_string());
            *counts.entry(t).or_insert(0) += 1;
        }
        let total = (self.all_acts.len() as u32).max(1);
        types
            .iter()
            .enumerate()
            .map(|(i, label)| {
                let count = counts.get(label).copied().unwrap_or(0);
                let percent = ((count as f64 / total as f64) * 100.0).round() as u32;
                (label.clone(), count, percent, TYPE_COLORS[i % TYPE_COLORS.len()])
            })
            .collect()
    }
}

fn buckets_label_threshold(_max: usize) -> usize { 100 } // every label except the last is a bare digit

async fn run_loop(
    mut terminal: Terminal<CrosstermBackend<Stdout>>,
    mut rx: mpsc::UnboundedReceiver<TuiMsg>,
    mut shutdown_rx: watch::Receiver<bool>,
    output_repo: String,
) -> anyhow::Result<()> {
    let mut state = State::default();
    let mut interval = tokio::time::interval(Duration::from_millis(200));

    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                if !apply_msg(&mut state, msg) { break; }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow_and_update() {
                    teardown_and_exit(&output_repo);
                }
            }
            _ = interval.tick() => {
                draw(&mut terminal, &state)?;
                if poll_user_quit().unwrap_or(false) {
                    teardown_and_exit(&output_repo);
                }
            }
        }
    }

    Ok(())
}

/// Restore the terminal and exit — mirrors TS `screen.destroy(); process.exit(0)`.
fn teardown_and_exit(output_repo: &str) -> ! {
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen);
    checkout_main_sync_for_repo(output_repo);
    std::process::exit(130);
}

/// Returns false to signal shutdown.
fn apply_msg(state: &mut State, msg: TuiMsg) -> bool {
    match msg {
        TuiMsg::Shutdown => return false,
        TuiMsg::Log(s) => {
            state.log.push_back(format!("[{}] {s}", Utc::now().to_rfc3339()));
            while state.log.len() > LOG_CAP {
                state.log.pop_front();
            }
        }
        TuiMsg::Status(s) => state.status = s,
        TuiMsg::UpdateList(items) => {
            for it in &items {
                state.record_act(it);
            }
            for it in items {
                state.list_items.push_back(it);
                while state.list_items.len() > LIST_CAP {
                    state.list_items.pop_front();
                }
            }
        }
        TuiMsg::UpdateRefs(codice, refs) => {
            state.ref_counts.insert(codice, refs);
        }
        TuiMsg::SeedCharts(versions) => {
            for (codice, entry) in versions {
                if state.seen_codes.insert(codice.clone()) {
                    state.ref_counts.insert(codice.clone(), entry.refs.unwrap_or(0));
                    state.all_acts.push(NormattivaAtto {
                        codice_redazionale: codice,
                        data_gu: entry.date.clone(),
                        anno_provvedimento: entry.year.clone(),
                        denominazione_atto: entry.kind.clone(),
                        ..Default::default()
                    });
                }
            }
        }
    }
    true
}

fn poll_user_quit() -> io::Result<bool> {
    if event::poll(Duration::from_millis(0))? {
        if let Event::Key(k) = event::read()? {
            if matches!(k.code, KeyCode::Char('q')) || (k.code == KeyCode::Char('c') && k.modifiers.contains(event::KeyModifiers::CONTROL)) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn draw(terminal: &mut Terminal<CrosstermBackend<Stdout>>, state: &State) -> io::Result<()> {
    terminal.draw(|f| {
        let area = f.size();
        let outer = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(7), Constraint::Length(3)])
            .split(area);

        let top = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(outer[0]);

        let right = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(34),
                Constraint::Percentage(33),
                Constraint::Percentage(33),
            ])
            .split(top[1]);

        // Left: act list
        let items: Vec<ListItem> = state
            .list_items
            .iter()
            .rev()
            .take(top[0].height as usize)
            .map(|a| {
                ListItem::new(format!(
                    "{} - {} - {}",
                    a.data_gu.get(0..10).unwrap_or(""),
                    a.numero_gu.as_deref().unwrap_or(&a.codice_redazionale),
                    a.titolo_atto.as_deref().unwrap_or("")
                ))
            })
            .collect();
        let list = List::new(items)
            .block(Block::default().borders(Borders::ALL).title(" Atti aggiornati "))
            .highlight_style(Style::default().bg(Color::Blue));
        f.render_widget(list, top[0]);

        // Right top: decades chart (one BarChart per type, colored differently)
        let types = state.top_types();
        let decades = state.decade_grid(&types);
        render_decades(f, right[0], &types, &decades);

        // Right middle: ref distribution
        let max_buckets = ((right[1].width as usize).saturating_sub(2) / 6).clamp(6, 11);
        let dist = state.ref_distribution(max_buckets);
        render_ref_dist(f, right[1], &dist);

        // Right bottom: type-share legend
        let type_dist = state.type_distribution(&types);
        render_type_dist(f, right[2], &type_dist);

        // Log panel
        let log_lines: Vec<Line> = state
            .log
            .iter()
            .rev()
            .take(outer[1].height as usize)
            .rev()
            .map(|l| Line::from(l.as_str()))
            .collect();
        let log = Paragraph::new(log_lines)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(" Log "));
        f.render_widget(log, outer[1]);

        // Status
        let status = Paragraph::new(state.status.as_str())
            .style(Style::default().add_modifier(Modifier::BOLD))
            .block(Block::default().borders(Borders::ALL).title(" Stato "));
        f.render_widget(status, outer[2]);
    })?;
    Ok(())
}

fn render_decades(
    f: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    types: &[String],
    decades: &[(String, Vec<u32>)],
) {
    let block = Block::default().borders(Borders::ALL).title(" Atti per decennio ");
    let inner = block.inner(area);
    f.render_widget(block, area);

    if decades.is_empty() || types.is_empty() {
        return;
    }

    // For each decade, render one stacked column as TYPE_COLORS bars side-by-side.
    let groups: Vec<BarGroup> = decades
        .iter()
        .map(|(label, counts)| {
            let bars: Vec<Bar> = counts
                .iter()
                .enumerate()
                .map(|(i, &n)| {
                    Bar::default()
                        .value(n as u64)
                        .style(Style::default().fg(TYPE_COLORS[i % TYPE_COLORS.len()]))
                })
                .collect();
            BarGroup::default()
                .label(Line::from(label.as_str()))
                .bars(&bars)
        })
        .collect();

    let mut chart = BarChart::default().bar_width(1).bar_gap(0).group_gap(1);
    for g in groups {
        chart = chart.data(g);
    }
    f.render_widget(chart, inner);
}

fn render_ref_dist(
    f: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    dist: &[(String, u32)],
) {
    let block = Block::default().borders(Borders::ALL).title(" Riferimenti per atto ");
    let inner = block.inner(area);
    f.render_widget(block, area);

    if dist.is_empty() { return; }
    let bars: Vec<Bar> = dist
        .iter()
        .map(|(label, n)| {
            Bar::default()
                .label(Line::from(label.as_str()))
                .value(*n as u64)
                .style(Style::default().fg(Color::Blue))
        })
        .collect();
    let chart = BarChart::default()
        .bar_width(3)
        .bar_gap(1)
        .data(BarGroup::default().bars(&bars));
    f.render_widget(chart, inner);
}

fn render_type_dist(
    f: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    items: &[(String, u32, u32, Color)],
) {
    let block = Block::default().borders(Borders::ALL).title(" Tipi di atti ");
    let inner = block.inner(area);
    f.render_widget(block, area);

    if items.is_empty() { return; }
    // Render as a stack of one-line gauges, then a final legend line.
    let mut constraints: Vec<Constraint> = items.iter().map(|_| Constraint::Length(1)).collect();
    constraints.push(Constraint::Min(1));
    let rows = Layout::default().direction(Direction::Vertical).constraints(constraints).split(inner);

    for ((label, _count, percent, color), area) in items.iter().zip(rows.iter()) {
        let bar_width = ((*percent as usize) * area.width as usize / 100).min(area.width as usize);
        let filled: String = "█".repeat(bar_width);
        let line = Line::from(vec![
            Span::styled(format!("{filled:<width$}", width = area.width as usize), Style::default().fg(*color)),
            Span::raw(format!(" {label} {percent}%")),
        ]);
        f.render_widget(Paragraph::new(line), *area);
    }

    if let Some(legend_area) = rows.last() {
        let legend: Vec<Span> = items
            .iter()
            .flat_map(|(label, _c, percent, color)| {
                vec![
                    Span::styled("■ ", Style::default().fg(*color)),
                    Span::raw(format!("{label} {percent}%  ")),
                ]
            })
            .collect();
        f.render_widget(Paragraph::new(Line::from(legend)), *legend_area);
    }
}
