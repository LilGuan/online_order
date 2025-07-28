import { useState } from "react";

const menuData = [
  {
    id: 1,
    name: "蝦仁炒飯",
    price: 120,
    image: "images/shirmp.png",
  },
  {
    id: 2,
    name: "牛肉麵",
    price: 150,
    image: "images/beef-noodle.png",
  },
  {
    id: 3,
    name: "炸雞塊",
    price: 80,
    image: "images/fried-chicken.png",
  },
];

export default function MenuGrid() {
  const [quantities, setQuantities] = useState(
    Object.fromEntries(menuData.map((item) => [item.id, 1]))
  );

  const updateQuantity = (id, amount) => {
    setQuantities((prev) => ({
      ...prev,
      [id]: Math.max(1, prev[id] + amount),
    }));
  };

  const handleOrder = (item) => {
    const qty = quantities[item.id];
    alert(`已下單 ${item.name} x ${qty}，總共 $${qty * item.price}`);
    // 這裡可以改為實際送出 API 或加入購物車邏輯
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 p-6">
      {menuData.map((item) => (
        <div key={item.id} className="border rounded-2xl shadow p-4 flex flex-col items-center">
          <img src={item.image} alt={item.name} className="w-40 h-40 object-cover rounded-xl" />
          <h2 className="text-xl font-bold mt-2">{item.name}</h2>
          <p className="text-gray-600">NT$ {item.price}</p>

          <div className="flex items-center space-x-2 mt-4">
            <button
              onClick={() => updateQuantity(item.id, -1)}
              className="px-3 py-1 bg-gray-300 rounded hover:bg-gray-400"
            >
              -
            </button>
            <span className="min-w-[24px] text-center">{quantities[item.id]}</span>
            <button
              onClick={() => updateQuantity(item.id, 1)}
              className="px-3 py-1 bg-gray-300 rounded hover:bg-gray-400"
            >
              +
            </button>
          </div>

          <button
            onClick={() => handleOrder(item)}
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            下單
          </button>
        </div>
      ))}
    </div>
  );
}
