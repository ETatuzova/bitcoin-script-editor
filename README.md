# Checkout with dependencies recursively
```
git clone git@github.com:ETatuzova/bitcoin-script-editor.git --init --recursive
```
# Build debugger app
```
cd indexer
sudo ./ci/run_dev.sh
mkdir build
cd build
cmake ..
make bitcoin-debugger
```
# Run back-end
Run from the project root folder
```
node backend/backend.js
```
# Run front-end
Run from the project root folder
```
npm run dev
```
# Try script editor locally
Address: `http://localhost:5173/`
