import {useState} from 'react';

function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1>你好</h1>

      <h4>当前计数: {count}</h4>
      <button onClick={() => setCount(count + 1)}>+1</button>
    </div>
  );
}

export default App;
