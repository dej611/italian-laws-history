//! Produce a V8 `.cpuprofile` from a `pprof` sampling run.
//!
//! Start the guard early in `main()`, drop it at the end — the file is written on `Drop`.
//!
//! **Timeline caveat**: pprof aggregates samples; per-sample timestamps are not preserved.
//! The generated timeline is uniform (constant `timeDeltas`).  Bottom-up, call-tree, and
//! flame views in Chrome DevTools are accurate; the timeline strip will look flat.
//!
//! Build with `--features cpuprofile`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use pprof::{ProfilerGuardBuilder, Report};
use serde::Serialize;

pub struct Guard {
    inner: pprof::ProfilerGuard<'static>,
    started_us: u64,
    started_at: Instant,
    out: PathBuf,
}

pub fn start(out: PathBuf) -> Guard {
    let inner = ProfilerGuardBuilder::default()
        .frequency(100)
        .blocklist(&["libc", "libgcc", "pthread", "vdso"])
        .build()
        .expect("pprof guard");
    Guard {
        inner,
        started_us: now_us(),
        started_at: Instant::now(),
        out,
    }
}

// ── V8 .cpuprofile schema ────────────────────────────────────────────────────

#[derive(Serialize)]
struct CallFrame {
    #[serde(rename = "functionName")]
    function_name: String,
    #[serde(rename = "scriptId")]
    script_id: String,
    url: String,
    #[serde(rename = "lineNumber")]
    line_number: i32,
    #[serde(rename = "columnNumber")]
    column_number: i32,
}

#[derive(Serialize)]
struct Node {
    id: u32,
    #[serde(rename = "callFrame")]
    call_frame: CallFrame,
    #[serde(rename = "hitCount")]
    hit_count: u32,
    children: Vec<u32>,
}

#[derive(Serialize)]
struct CpuProfile {
    nodes: Vec<Node>,
    #[serde(rename = "startTime")]
    start_time: u64,
    #[serde(rename = "endTime")]
    end_time: u64,
    samples: Vec<u32>,
    #[serde(rename = "timeDeltas")]
    time_deltas: Vec<u32>,
}

// ── Drop: convert and write ──────────────────────────────────────────────────

impl Drop for Guard {
    fn drop(&mut self) {
        let report: Report = match self.inner.report().build() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("pprof report failed: {e}");
                return;
            }
        };

        let elapsed_us = self.started_at.elapsed().as_micros() as u64;
        let end_us = self.started_us + elapsed_us;

        // Build the call tree. Root node has id=1, name "(root)".
        let mut nodes: Vec<Node> = vec![Node {
            id: 1,
            call_frame: make_frame("(root)", "", 0),
            hit_count: 0,
            children: vec![],
        }];
        // (parent_id, frame_label) → child node id
        let mut index: HashMap<(u32, String), u32> = HashMap::new();
        // (leaf_node_id, sample_count) collected for timeline synthesis
        let mut leaf_counts: Vec<(u32, isize)> = Vec::new();

        for (frames, &count) in &report.data {
            // frames.frames is Vec<Vec<Symbol>>, outermost frame first.
            // Reverse so we walk root → leaf when building the tree.
            let stack: Vec<String> = frames
                .frames
                .iter()
                .rev()
                .map(|syms| syms.first().map(symbol_label).unwrap_or_else(|| "??".into()))
                .collect();

            let mut parent: u32 = 1;
            for label in &stack {
                let key = (parent, label.clone());
                let child_id = if let Some(&id) = index.get(&key) {
                    id
                } else {
                    let id = (nodes.len() + 1) as u32;
                    let (fname, url, line) = split_label(label);
                    nodes.push(Node {
                        id,
                        call_frame: make_frame(&fname, &url, line),
                        hit_count: 0,
                        children: vec![],
                    });
                    // parent index is id-1 (1-indexed nodes stored 0-indexed)
                    nodes[parent as usize - 1].children.push(id);
                    index.insert(key, id);
                    id
                };
                parent = child_id;
            }

            nodes[parent as usize - 1].hit_count += count as u32;
            leaf_counts.push((parent, count));
        }

        // Synthesise a uniform timeline from aggregate sample counts.
        let total_samples: isize = leaf_counts.iter().map(|(_, c)| *c).sum();
        let total_samples = total_samples.max(1) as u64;
        let delta_us = (elapsed_us / total_samples).max(1) as u32;

        let mut samples: Vec<u32> = Vec::with_capacity(total_samples as usize);
        let mut time_deltas: Vec<u32> = Vec::with_capacity(total_samples as usize);
        for (id, count) in &leaf_counts {
            for _ in 0..*count {
                samples.push(*id);
                time_deltas.push(delta_us);
            }
        }

        let profile = CpuProfile {
            nodes,
            start_time: self.started_us,
            end_time: end_us,
            samples,
            time_deltas,
        };

        if let Some(dir) = self.out.parent() {
            let _ = fs::create_dir_all(dir);
        }
        match serde_json::to_vec(&profile) {
            Ok(buf) => {
                if let Err(e) = fs::write(&self.out, buf) {
                    eprintln!("cpuprofile write failed: {e}");
                } else {
                    eprintln!("cpuprofile -> {}", self.out.display());
                }
            }
            Err(e) => eprintln!("cpuprofile serialize failed: {e}"),
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

fn make_frame(name: &str, url: &str, line: i32) -> CallFrame {
    CallFrame {
        function_name: name.into(),
        script_id: "0".into(),
        url: url.into(),
        line_number: line,
        column_number: 0,
    }
}

/// Encode all symbol attributes into a single dedupe key: "name\0file\0line".
fn symbol_label(s: &pprof::Symbol) -> String {
    let name = s.name();
    let file = s.filename().to_string();
    let line = s.lineno();
    format!("{name}\0{file}\0{line}")
}

/// Reverse of `symbol_label`.
fn split_label(label: &str) -> (String, String, i32) {
    let mut parts = label.splitn(3, '\0');
    let name = parts.next().unwrap_or("??").to_string();
    let file = parts.next().unwrap_or("").to_string();
    let line: i32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (name, file, line)
}
