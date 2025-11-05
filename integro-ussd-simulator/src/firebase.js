// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBjS8gfZMynr8kdeodC61b0X37GJevHy_E",
  authDomain: "integro-ecosystem.firebaseapp.com",
  projectId: "integro-ecosystem",
  storageBucket: "integro-ecosystem.appspot.com",
  messagingSenderId: "285529185485",
  appId: "1:285529185485:web:7cfe295b71e13d5b789d84",
  measurementId: "G-42CZ3J0DDN"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const db = getFirestore(app);

// Create a callable function reference
export const ussdGateway = httpsCallable(functions, 'ussdGateway');

export { db };
