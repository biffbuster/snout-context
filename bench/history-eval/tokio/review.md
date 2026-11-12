# tokio: questions for a person to check

Written and checked by the model on 2026-11-09, before any run. Each answerable question names the commit that answers it; each unanswerable one was checked against git log for the window.

## Answerable
1. Can I give a Tokio runtime a name through the tokio::main macro?
   Answer: 7947fa4bd7 "rt: add runtime name (#7924)"
2. Is there a way to get a mutable reference to the next item of a Peekable stream, or poll for a peek?
   Answer: ddc60948ab "stream: add peek_mut, poll_peek to Peekable (#8262)"
3. Why does mpsc Permit::send forget the permit before sending, and what goes wrong if the receiver's waker panics?
   Answer: 5b758f5b5b "sync: forget mpsc `Permit` before sending value (#8560)"
4. On emscripten without JSPI, how does block_on wait when the runtime parks?
   Answer: 3eb95a40f1 "wasm: use sleep on emscripten without JSPI (#8528)"
5. Does StreamNotifyClose implement FusedStream?
   Answer: 6276684c28 "stream: implement FusedStream for StreamNotifyClose (#8452)"
6. Does the futures compat wrapper in tokio-util pass vectored writes through?
   Answer: 7f67a1bd61 "compat: forward Tokio vectored writes (#8588)"
7. When an alternative timer entry is cancelled, why is its stored waker dropped right away instead of during timer maintenance?
   Answer: 471d65dec2 "time: drop stored waker when cancelling alt timer entry (#8550)"
8. Why did the queue stress1 test sometimes come up a few tasks short?
   Answer: 38631ed3de "rt: fix spurious failure in queue `stress1` test (#8524)"
9. Why were the tracing_sync tests changed from async tests to synchronous ones?
   Answer: 0448618493 "sync: make `tracing_sync` tests synchronous (#8427)"
10. Closing a semaphore could deadlock when a waker released a permit; how was that fixed?
   Answer: 3536cd6987 "sync: wake waiters outside the lock when closing a semaphore (#8529)"
11. When did we start running Miri on the TCP socket tests?
   Answer: 32312ae0d6 "net: enable Miri tests for TCP socket (#8156)"
12. Could a panic in a tracing event during poll_acquire leak semaphore permits?
   Answer: 832dd23329 "sync: avoid leaking semaphore permits on tracing panic (#8542)"
13. What memory ordering guarantees does the Semaphore documentation give?
   Answer: 88212ab64a "sync: document memory ordering guarantees for Semaphore (#8119)"
14. Is there a benchmark for inject queue contention when spawning from outside the runtime?
   Answer: ee04abe797 "bench: add remote_spawn benchmark for inject queue contention (#7944)"
15. Does releasing an mpsc OwnedPermit wake receivers waiting on the channel?
   Answer: f085b6211b "sync: notify receivers in mpsc `OwnedPermit::release()` method (#8075)"

## Unanswerable in this history
1. Why did the default runtime switch to a single-threaded executor?
2. When was async-std compatibility added to tokio-util?
3. Why was Unix domain socket support removed?
4. What broke when tokio moved to the Rust 2027 edition?
5. Why does tokio::fs use mmap for reads now?
6. When did tokio add a built-in HTTP/3 client?
7. Why was the broadcast channel rewritten on top of crossbeam?
8. Why did tokio drop support for Windows named pipes? (hard: a commit adds safety docs and Default impls for named pipe options; it doesn't answer this)
9. Why does the runtime pin worker threads to CPU cores by default now?
10. When was tokio::sync::Mutex made to poison on panic like std's?
11. Why was JoinSet deprecated?
12. What changed when the timer wheel was replaced with a binary heap?
13. Why does tokio-stream depend on rayon now?
14. When did tokio add Python bindings?
15. Why did tokio::select! start requiring futures to be Unpin?
