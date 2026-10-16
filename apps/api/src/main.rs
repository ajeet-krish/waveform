//! Waveform API entrypoint. The real work lives in the `waveform_api`
//! library crate; this binary only starts it.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    waveform_api::run().await
}
