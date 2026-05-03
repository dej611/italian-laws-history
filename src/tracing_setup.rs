use chrono::Utc;
use tracing_chrome::{ChromeLayerBuilder, FlushGuard};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Registry};

/// Initialise the tracing subscriber.
///
/// When `--perf` is set we attach `tracing-chrome`, which writes a
/// Chrome Trace Event JSON file (`trace-<timestamp>.json`) at process
/// shutdown — same artefact as the TS `--perf` flag. The returned
/// guard must be held for the life of the process.
pub fn init(perf: bool) -> Option<FlushGuard> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,italian_laws_history=info"));

    if perf {
        let ts = Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let (chrome_layer, guard) = ChromeLayerBuilder::new()
            .file(format!("trace-{ts}.json"))
            .include_args(true)
            .build();

        Registry::default().with(filter).with(chrome_layer).init();
        eprintln!("Trace will be written to trace-{ts}.json");
        Some(guard)
    } else {
        Registry::default().with(filter).init();
        None
    }
}
