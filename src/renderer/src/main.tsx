import ReactDOM from 'react-dom/client'
import './styles.css'
import App from './App'

// 不使用 StrictMode：开发模式下它会重复挂载，导致音频采集与识别连接被创建两次
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
